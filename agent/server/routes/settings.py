"""Settings API endpoints for runtime LLM configuration."""

from fastapi import APIRouter, HTTPException

from agent.core.database import Database
from agent.server.models import SettingsPatch, SettingsResponse, ConfigStatus

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _get_db() -> Database:
    return Database()


def _validate_non_empty(field_name: str, value: str) -> str:
    normalized = (value or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail=f"{field_name} cannot be empty")
    return normalized


@router.get("/status", response_model=ConfigStatus)
def get_config_status():
    db = _get_db()
    return ConfigStatus(is_configured=db.is_configured())


@router.get("", response_model=SettingsResponse)
def get_settings():
    """Return current settings without exposing API key."""
    db = _get_db()
    return SettingsResponse(
        llm_base_url=db.get_setting("llm_base_url"),
        llm_model_name=db.get_setting("llm_model_name"),
        is_configured=db.is_configured(),
    )


@router.patch("", response_model=SettingsResponse)
def update_settings(body: SettingsPatch):
    """Update runtime settings with minimal input validation."""
    db = _get_db()

    if body.llm_base_url is not None:
        db.set_setting("llm_base_url", _validate_non_empty("llm_base_url", body.llm_base_url))

    if body.llm_api_key is not None:
        db.set_setting("llm_api_key", (body.llm_api_key or "").strip())

    if body.llm_model_name is not None:
        db.set_setting("llm_model_name", _validate_non_empty("llm_model_name", body.llm_model_name))

    return SettingsResponse(
        llm_base_url=db.get_setting("llm_base_url"),
        llm_model_name=db.get_setting("llm_model_name"),
        is_configured=db.is_configured(),
    )
