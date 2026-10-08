from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from typing import Literal


class ChatPayload(BaseModel):
    """One user turn. `sub` is trusted: the streaming Lambda verified the Cognito JWT before invoking the runtime.
    The token itself is not forwarded: the runtime signs its Gateway calls with its own role. Unknown fields are ignored so
    a relay deployed earlier (which still sends idToken) keeps working during a rollout."""

    model_config = ConfigDict(extra="ignore")

    sub: str = Field(min_length=1, max_length=128)
    sessionId: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    message: str = Field(min_length=1, max_length=8000)
    meetingId: str | None = Field(default=None, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    lectureId: str | None = Field(default=None, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    sourceType: Literal["meeting", "lecture", "all"] | None = None
    language: str = Field(default="ko", max_length=8)
