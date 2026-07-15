import asyncio
from types import SimpleNamespace

import pytest
from azure.ai.voicelive.models import ServerEventType
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import main as main_module
from app import voice_live as voice_live_module
from app.settings import Settings
from app.voice_live import AVATAR_PROFILES, VoiceLiveStart, build_voice_live_session


class FakeLimiter:
    def __init__(self) -> None:
        self.reservations: list[tuple] = []
        self.releases: list[tuple] = []

    async def reserve(self, *args) -> None:
        self.reservations.append(args)

    async def release(self, *args) -> None:
        self.releases.append(args)


class FakeVoiceLiveConnection:
    def __init__(self) -> None:
        self.events: asyncio.Queue = asyncio.Queue()
        self.session_updates = []
        self.audio_chunks: list[bytes] = []
        self.sent_events = []
        self.response_creates = 0
        self.response_cancels = 0
        self.session = SimpleNamespace(update=self.update_session)
        self.input_audio_buffer = SimpleNamespace(append=self.append_audio)
        self.response = SimpleNamespace(
            create=self.create_response,
            cancel=self.cancel_response,
        )
        ice_server = SimpleNamespace(
            urls=["turn:relay.example.test"],
            username="avatar-user",
            credential="avatar-credential",
        )
        avatar = SimpleNamespace(ice_servers=[ice_server])
        session = SimpleNamespace(id="azure-session", avatar=avatar)
        self.events.put_nowait(
            SimpleNamespace(type=ServerEventType.SESSION_UPDATED, session=session)
        )

    async def update_session(self, *, session) -> None:
        self.session_updates.append(session)

    async def append_audio(self, *, audio: bytes) -> None:
        self.audio_chunks.append(audio)

    async def send(self, event) -> None:
        self.sent_events.append(event)
        self.events.put_nowait(
            SimpleNamespace(
                type=ServerEventType.SESSION_AVATAR_CONNECTING,
                server_sdp="encoded-server-sdp",
            )
        )

    async def create_response(self) -> None:
        self.response_creates += 1
        self.events.put_nowait(
            SimpleNamespace(
                type=ServerEventType.RESPONSE_AUDIO_TRANSCRIPT_DELTA,
                delta="Hello",
                item_id="assistant-one",
                response_id="response-one",
            )
        )

    async def cancel_response(self) -> None:
        self.response_cancels += 1

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.events.get()


class FakeConnectionContext:
    def __init__(self, connection: FakeVoiceLiveConnection) -> None:
        self.connection = connection
        self.closed = False

    async def __aenter__(self) -> FakeVoiceLiveConnection:
        return self.connection

    async def __aexit__(self, *_args) -> None:
        self.closed = True


def test_voice_live_session_uses_server_owned_photo_avatar() -> None:
    request = VoiceLiveStart(
        type="start_session",
        scenarioId="SCN-003",
        scenarioVersion="1.0",
        difficulty="hard",
    )

    session = build_voice_live_session(request, Settings())
    payload = session.as_dict()

    assert payload["avatar"] == {
        "type": "photo-avatar",
        "character": "anika",
        "model": "vasa-1",
        "customized": False,
        "video": {
            "bitrate": 2_000_000,
            "codec": "h264",
            "resolution": {"width": 1280, "height": 720},
        },
        "scene": {
            "zoom": 1.0,
            "position_x": 0.0,
            "position_y": 0.0,
            "rotation_x": 0.0,
            "rotation_y": 0.0,
            "rotation_z": 0.0,
            "amplitude": 0.55,
        },
        "output_protocol": "webrtc",
        "output_audit_audio": False,
    }
    assert payload["voice"]["name"] == AVATAR_PROFILES["SCN-003"].voice
    assert payload["input_audio_transcription"] == {
        "model": "azure-speech",
        "language": "en-US",
    }
    assert payload["turn_detection"]["create_response"] is True
    assert payload["turn_detection"]["interrupt_response"] is True
    assert "end_of_utterance_detection" not in payload["turn_detection"]
    assert "REF-AISHA-" in payload["instructions"]
    assert "REF-MARIA-" not in payload["instructions"]


def test_each_scenario_has_a_distinct_standard_avatar() -> None:
    assert set(AVATAR_PROFILES) == {"SCN-001", "SCN-002", "SCN-003"}
    assert {
        scenario_id: profile.character
        for scenario_id, profile in AVATAR_PROFILES.items()
    } == {
        "SCN-001": "camila",
        "SCN-002": "darius",
        "SCN-003": "anika",
    }


def test_voice_live_websocket_bridges_avatar_and_releases_lease(monkeypatch) -> None:
    connection = FakeVoiceLiveConnection()
    context = FakeConnectionContext(connection)
    connect_calls = []

    def fake_connect(**kwargs):
        connect_calls.append(kwargs)
        return context

    limiter = FakeLimiter()
    monkeypatch.setattr(voice_live_module, "connect", fake_connect)
    monkeypatch.setattr(main_module.realtime_broker, "limiter", limiter)
    monkeypatch.setattr(main_module.settings, "app_mode", "azure")
    monkeypatch.setattr(
        main_module.settings,
        "azure_voice_live_endpoint",
        "https://voice.example.test",
    )
    monkeypatch.setattr(main_module.settings, "allowed_origins", "http://testserver")

    browser = TestClient(main_module.app)
    browser.get("/api/config")
    with browser.websocket_connect(
        "/api/voice-live", headers={"origin": "http://testserver"}
    ) as websocket:
        websocket.send_json(
            {
                "type": "start_session",
                "scenarioId": "SCN-001",
                "scenarioVersion": "1.0",
                "difficulty": "medium",
            }
        )

        assert websocket.receive_json() == {
            "type": "session_started",
            "sessionId": "azure-session",
            "model": "gpt-realtime-1.5",
            "transcriptionModel": "azure-speech",
            "grounding": {
                "mode": "synthetic-local",
                "datasetId": "empathyai-synthetic-v1",
                "queryBasis": "scenario",
                "sources": [
                    {
                        "id": "REF-MARIA-001",
                        "title": "Naming fear before explaining next steps",
                    },
                    {
                        "id": "REF-MARIA-002",
                        "title": "Generic reassurance leaves the concern unanswered",
                    },
                    {
                        "id": "REF-MARIA-003",
                        "title": "Repairing prognosis and palliative jargon",
                    },
                ],
            },
        }
        ice = websocket.receive_json()
        assert ice["type"] == "ice_servers"
        assert ice["iceServers"][0]["credential"] == "avatar-credential"

        websocket.send_json(
            {"type": "avatar_sdp_offer", "clientSdp": "encoded-client-sdp"}
        )
        assert websocket.receive_json() == {
            "type": "avatar_sdp_answer",
            "serverSdp": "encoded-server-sdp",
        }

        websocket.send_bytes(b"\x00\x01" * 480)
        websocket.send_json({"type": "avatar_ready"})
        assert websocket.receive_json() == {
            "type": "transcript_delta",
            "role": "assistant",
            "delta": "Hello",
            "itemId": "assistant-one",
            "responseId": "response-one",
        }
        websocket.send_json({"type": "interrupt"})
        websocket.send_json({"type": "stop_session"})
        with pytest.raises(WebSocketDisconnect):
            websocket.receive_json()

    assert connect_calls[0]["endpoint"] == "https://voice.example.test"
    assert connect_calls[0]["model"] == "gpt-realtime-1.5"
    assert len(connection.session_updates) == 1
    assert connection.sent_events[0].as_dict()["client_sdp"] == "encoded-client-sdp"
    assert connection.audio_chunks == [b"\x00\x01" * 480]
    assert connection.response_creates == 1
    assert connection.response_cancels == 1
    assert context.closed is True
    assert len(limiter.reservations) == 1
    assert limiter.releases == [
        (limiter.reservations[0][0], limiter.reservations[0][2])
    ]
