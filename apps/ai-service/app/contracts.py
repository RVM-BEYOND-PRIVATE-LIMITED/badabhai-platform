"""Pydantic contracts for the AI service.

MIRRORS the Zod contracts in `packages/ai-contracts/src/index.ts`. Keep both in
sync. PRIVACY: these never carry raw identity (no phone, name, address, employer).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# --- Conversation ----------------------------------------------------------
class ConversationMessage(BaseModel):
    role: Literal["worker", "assistant", "system"]
    text: str


# --- Profiling turn --------------------------------------------------------
class ProfilingTurnInput(BaseModel):
    session_id: str = Field(min_length=1)
    worker_ref: str | None = None
    language: str | None = None
    message_text: str = Field(min_length=1)
    history: list[ConversationMessage] = Field(default_factory=list)


class ProfilingTurnOutput(BaseModel):
    reply_text: str
    blocked: bool = False
    blocked_reason: str | None = None
    suggested_followups: list[str] = Field(default_factory=list)
    is_mock: bool = True


# --- Pseudonymization ------------------------------------------------------
class PseudonymizationInput(BaseModel):
    text: str
    request_id: str | None = None


class PseudonymizationOutput(BaseModel):
    pseudonymized_text: str
    blocked: bool
    blocked_reason: str | None = None
    replaced_entities: int = 0
    placeholder_tokens: list[str] = Field(default_factory=list)


# --- Draft profile (shared) ------------------------------------------------
class Experience(BaseModel):
    total_years: float | None = None
    summary: str | None = None


class SalaryExpectation(BaseModel):
    amount_min: float | None = None
    amount_max: float | None = None
    currency: str = "INR"
    period: Literal["monthly", "daily", "yearly"] = "monthly"


class LocationPreference(BaseModel):
    preferred_cities: list[str] = Field(default_factory=list)
    willing_to_relocate: bool | None = None


class Availability(BaseModel):
    status: Literal["immediate", "notice_period", "not_looking", "unknown"] = "unknown"
    notice_period_days: int | None = None


class DraftProfile(BaseModel):
    canonical_trade_id: str | None = None
    canonical_role_id: str | None = None
    skills: list[str] = Field(default_factory=list)
    machines: list[str] = Field(default_factory=list)
    experience: Experience = Field(default_factory=Experience)
    salary_expectation: SalaryExpectation = Field(default_factory=SalaryExpectation)
    location_preference: LocationPreference = Field(default_factory=LocationPreference)
    availability: Availability = Field(default_factory=Availability)
    confidence: float | None = None


# --- Profile extraction ----------------------------------------------------
class ProfileExtractionInput(BaseModel):
    worker_ref: str | None = None
    language: str | None = None
    transcript: str | None = None
    messages: list[ConversationMessage] | None = None


class ProfileExtractionOutput(BaseModel):
    profile: DraftProfile
    blocked: bool = False
    blocked_reason: str | None = None
    is_mock: bool = True


# --- Resume generation -----------------------------------------------------
class ResumeGenerationInput(BaseModel):
    profile: DraftProfile
    language: str | None = None


class ResumeGenerationOutput(BaseModel):
    resume_text: str
    resume_json: dict = Field(default_factory=dict)
    format: Literal["text", "json"] = "text"
    is_mock: bool = True
