import asyncio
import json
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Literal

from azure.ai.voicelive.aio import connect
from azure.ai.voicelive.models import (
    AudioEchoCancellation,
    AudioInputTranscriptionOptions,
    AudioNoiseReduction,
    AvatarConfig,
    AzureSemanticVad,
    AzureStandardVoice,
    ClientEventSessionAvatarConnect,
    InputAudioFormat,
    Modality,
    OutputAudioFormat,
    RequestSession,
    Scene,
    ServerEventType,
    VideoParams,
    VideoResolution,
)
from fastapi import WebSocket
from pydantic import Field

from .models import StrictModel
from .rag import GroundingBundle, retrieve_scenario_grounding
from .realtime import build_prompt
from .scenarios import SCENARIOS
from .settings import Settings


@dataclass(frozen=True)
class AvatarProfile:
    character: str
    voice: str


AVATAR_PROFILES = {
    "SCN-001": AvatarProfile(
        character="camila", voice="en-US-Ava:DragonHDLatestNeural"
    ),
    "SCN-002": AvatarProfile(
        character="darius", voice="en-US-Andrew:DragonHDLatestNeural"
    ),
    "SCN-003": AvatarProfile(
        character="anika", voice="en-US-Emma:DragonHDLatestNeural"
    ),
}

MAX_AUDIO_CHUNK_BYTES = 48_000
MAX_CONTROL_MESSAGE_BYTES = 128_000


class VoiceLiveStart(StrictModel):
    type: Literal["start_session"]
    scenarioId: Literal["SCN-001", "SCN-002", "SCN-003"]
    scenarioVersion: Literal["1.0"]
    difficulty: Literal["easy", "medium", "hard"]


class AvatarSdpOffer(StrictModel):
    type: Literal["avatar_sdp_offer"]
    clientSdp: str = Field(min_length=1, max_length=MAX_CONTROL_MESSAGE_BYTES)


class AvatarReady(StrictModel):
    type: Literal["avatar_ready"]


class Interrupt(StrictModel):
    type: Literal["interrupt"]


class StopSession(StrictModel):
    type: Literal["stop_session"]


class VoiceLiveProtocolError(ValueError):
    pass


def build_voice_live_session(
    request: VoiceLiveStart,
    settings: Settings,
    grounding: GroundingBundle | None = None,
) -> RequestSession:
    profile = AVATAR_PROFILES[request.scenarioId]
    avatar = AvatarConfig(
        avatar_type="photo-avatar",
        character=profile.character,
        model="vasa-1",
        customized=False,
        output_protocol="webrtc",
        output_audit_audio=False,
        video=VideoParams(
            codec="h264",
            bitrate=2_000_000,
            resolution=VideoResolution(width=1280, height=720),
        ),
        scene=Scene(
            zoom=1.0,
            position_x=0.0,
            position_y=0.0,
            rotation_x=0.0,
            rotation_y=0.0,
            rotation_z=0.0,
            amplitude=0.55,
        ),
    )
    turn_detection = AzureSemanticVad(
        prefix_padding_ms=300,
        silence_duration_ms=500,
        speech_duration_ms=80,
        remove_filler_words=True,
        auto_truncate=True,
        create_response=True,
        interrupt_response=True,
    )
    return RequestSession(
        modalities=[Modality.TEXT, Modality.AUDIO],
        instructions=build_prompt(request, grounding),
        voice=AzureStandardVoice(name=profile.voice),
        avatar=avatar,
        input_audio_format=InputAudioFormat.PCM16,
        output_audio_format=OutputAudioFormat.PCM16,
        input_audio_transcription=AudioInputTranscriptionOptions(
            model=settings.azure_voice_live_transcription_model,
            language="en-US",
        ),
        turn_detection=turn_detection,
        input_audio_noise_reduction=AudioNoiseReduction(
            type="azure_deep_noise_suppression"
        ),
        input_audio_echo_cancellation=AudioEchoCancellation(
            type="server_echo_cancellation"
        ),
        temperature=0.8,
    )


class VoiceLiveBridge:
    def __init__(
        self,
        websocket: WebSocket,
        credential: Any,
        settings: Settings,
        session_id: str,
    ) -> None:
        self.websocket = websocket
        self.credential = credential
        self.settings = settings
        self.session_id = session_id
        self._avatar_answer_sent = False
        self._opening_sent = False
        self._grounding: GroundingBundle | None = None

    async def run(self, request: VoiceLiveStart) -> None:
        self._grounding = retrieve_scenario_grounding(
            request.scenarioId,
            SCENARIOS[request.scenarioId],
            request.difficulty,
        )
        async with asyncio.timeout(self.settings.session_max_minutes * 60):
            async with connect(
                credential=self.credential,
                endpoint=self.settings.azure_voice_live_endpoint,
                model=self.settings.azure_voice_live_model,
            ) as connection:
                await connection.session.update(
                    session=build_voice_live_session(
                        request,
                        self.settings,
                        self._grounding,
                    )
                )
                await self._pump(connection)

    async def _pump(self, connection: Any) -> None:
        tasks = {
            asyncio.create_task(self._receive_browser(connection)),
            asyncio.create_task(self._relay_service(connection)),
        }
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            task.result()

    async def _receive_browser(self, connection: Any) -> None:
        while True:
            message = await self.websocket.receive()
            if message["type"] == "websocket.disconnect":
                return

            audio = message.get("bytes")
            if audio is not None:
                if not audio or len(audio) > MAX_AUDIO_CHUNK_BYTES:
                    raise VoiceLiveProtocolError("Invalid microphone audio chunk.")
                await connection.input_audio_buffer.append(audio=audio)
                continue

            text = message.get("text")
            if not isinstance(text, str) or len(text) > MAX_CONTROL_MESSAGE_BYTES:
                raise VoiceLiveProtocolError("Invalid control message.")
            await self._handle_control(connection, text)
            if json.loads(text).get("type") == "stop_session":
                return

    async def _handle_control(self, connection: Any, text: str) -> None:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise VoiceLiveProtocolError("Invalid control message.") from exc
        if not isinstance(payload, dict):
            raise VoiceLiveProtocolError("Invalid control message.")

        message_type = payload.get("type")
        if message_type == "avatar_sdp_offer":
            offer = AvatarSdpOffer.model_validate(payload)
            await connection.send(
                ClientEventSessionAvatarConnect(client_sdp=offer.clientSdp)
            )
        elif message_type == "avatar_ready":
            AvatarReady.model_validate(payload)
            if not self._avatar_answer_sent:
                raise VoiceLiveProtocolError("Avatar negotiation is not ready.")
            if not self._opening_sent:
                self._opening_sent = True
                await connection.response.create()
        elif message_type == "interrupt":
            Interrupt.model_validate(payload)
            with suppress(Exception):
                await connection.response.cancel()
        elif message_type == "stop_session":
            StopSession.model_validate(payload)
        else:
            raise VoiceLiveProtocolError("Unsupported control message.")

    async def _relay_service(self, connection: Any) -> None:
        async for event in connection:
            event_type = event.type
            if event_type == ServerEventType.SESSION_UPDATED:
                await self._relay_session_updated(event)
            elif event_type == ServerEventType.SESSION_AVATAR_CONNECTING:
                server_sdp = getattr(event, "server_sdp", "")
                if server_sdp:
                    self._avatar_answer_sent = True
                    await self.websocket.send_json(
                        {"type": "avatar_sdp_answer", "serverSdp": server_sdp}
                    )
            elif (
                event_type
                == ServerEventType.CONVERSATION_ITEM_INPUT_AUDIO_TRANSCRIPTION_COMPLETED
            ):
                await self.websocket.send_json(
                    {
                        "type": "transcript_done",
                        "role": "user",
                        "transcript": getattr(event, "transcript", ""),
                        "itemId": getattr(event, "item_id", ""),
                    }
                )
            elif event_type == ServerEventType.RESPONSE_AUDIO_TRANSCRIPT_DELTA:
                await self.websocket.send_json(
                    {
                        "type": "transcript_delta",
                        "role": "assistant",
                        "delta": getattr(event, "delta", ""),
                        "itemId": getattr(event, "item_id", ""),
                        "responseId": getattr(event, "response_id", ""),
                    }
                )
            elif event_type == ServerEventType.RESPONSE_AUDIO_TRANSCRIPT_DONE:
                await self.websocket.send_json(
                    {
                        "type": "transcript_done",
                        "role": "assistant",
                        "transcript": getattr(event, "transcript", ""),
                        "itemId": getattr(event, "item_id", ""),
                        "responseId": getattr(event, "response_id", ""),
                    }
                )
            elif event_type == ServerEventType.INPUT_AUDIO_BUFFER_SPEECH_STARTED:
                await self.websocket.send_json(
                    {
                        "type": "speech_started",
                        "itemId": getattr(event, "item_id", ""),
                    }
                )
            elif event_type == ServerEventType.INPUT_AUDIO_BUFFER_SPEECH_STOPPED:
                await self.websocket.send_json(
                    {
                        "type": "speech_stopped",
                        "itemId": getattr(event, "item_id", ""),
                    }
                )
            elif event_type == ServerEventType.RESPONSE_DONE:
                response = getattr(event, "response", None)
                await self.websocket.send_json(
                    {
                        "type": "response_done",
                        "responseId": getattr(response, "id", ""),
                    }
                )
            elif event_type == ServerEventType.ERROR:
                await self.websocket.send_json(
                    {
                        "type": "session_error",
                        "error": "The Azure voice session reported an error.",
                    }
                )
                return

    async def _relay_session_updated(self, event: Any) -> None:
        session = getattr(event, "session", None)
        service_session_id = getattr(session, "id", "") or self.session_id
        await self.websocket.send_json(
            {
                "type": "session_started",
                "sessionId": service_session_id,
                "model": self.settings.azure_voice_live_model,
                "transcriptionModel": self.settings.azure_voice_live_transcription_model,
                "grounding": (
                    self._grounding.public_summary("scenario")
                    if self._grounding
                    else None
                ),
            }
        )

        avatar = getattr(session, "avatar", None)
        servers = getattr(avatar, "ice_servers", None) or []
        ice_servers = []
        for server in servers:
            item = {"urls": server.urls}
            if getattr(server, "username", None):
                item["username"] = server.username
            if getattr(server, "credential", None):
                item["credential"] = server.credential
            ice_servers.append(item)
        if ice_servers:
            await self.websocket.send_json(
                {"type": "ice_servers", "iceServers": ice_servers}
            )
