from tortoise.models import Model
from tortoise import fields
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo


class Recording(Model):
    id = fields.IntField(pk=True, generated=True)
    created_at = fields.DatetimeField(auto_now_add=True)
    name = fields.TextField()
    audio_url = fields.TextField(null=True)
    transcript = fields.TextField(null=True)
    summary = fields.TextField(null=True)
    local_audio = fields.TextField(null=True)
    nas_audio = fields.TextField(null=True)
    duration = fields.IntField(null=True)  # Duration in seconds
    notes = fields.TextField(null=True)
    archived = fields.BooleanField(default=False)

    class Meta:
        table = "recording"
        ordering = ["-created_at"]

    def __str__(self):
        return f"Recording({self.id}, {self.name})"

    @property
    def duration_formatted(self) -> str:
        """Return duration in MM:SS format"""
        if not self.duration:
            return "00:00"
        minutes = self.duration // 60
        seconds = self.duration % 60
        return f"{minutes:02d}:{seconds:02d}"

    @property
    def created_at_formatted(self) -> str:
        """Return formatted creation time in CDMX timezone"""
        if not self.created_at:
            return "Unknown"
        # Convert to CDMX timezone
        cdmx_time = self.created_at.astimezone(ZoneInfo("America/Mexico_City"))
        return cdmx_time.strftime("%b %d %H:%M")

