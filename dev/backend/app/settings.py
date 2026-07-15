from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = "local"
    app_mode: Literal["mock", "azure"] = "mock"
    build_label: str = "local"
    allowed_origins: str = "http://localhost:5173,http://localhost:8000"
    frontend_dist_path: Path = Field(
        default_factory=lambda: (
            Path(__file__).resolve().parents[2] / "frontend" / "dist"
        )
    )

    azure_ai_endpoint: str = ""
    azure_realtime_deployment: str = "gpt-realtime-1-5"
    azure_transcription_deployment: str = "gpt-realtime-whisper"
    azure_voice_live_endpoint: str = Field(
        default="",
        validation_alias=AliasChoices(
            "AZURE_VOICELIVE_ENDPOINT", "azure_voice_live_endpoint"
        ),
    )
    azure_voice_live_model: str = Field(
        default="gpt-realtime-1.5",
        validation_alias=AliasChoices(
            "AZURE_VOICELIVE_MODEL", "azure_voice_live_model"
        ),
    )
    azure_voice_live_transcription_model: str = Field(
        default="azure-speech",
        validation_alias=AliasChoices(
            "AZURE_VOICELIVE_TRANSCRIPTION_MODEL",
            "azure_voice_live_transcription_model",
        ),
    )
    azure_storage_account_url: str = ""
    azure_scenario_container: str = "scenario-config"
    azure_result_container: str = "session-results"
    applicationinsights_connection_string: str = ""
    persist_results: bool = False
    session_max_minutes: int = 15
    debug_trace: bool = False

    @property
    def origin_list(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
