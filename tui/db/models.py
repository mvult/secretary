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

    @property
    def storage_status(self) -> str:
        """Return storage status as local/NAS/cloud boolean string"""
        import os
        
        # Check local storage
        has_local = bool(self.local_audio and os.path.exists(self.local_audio))
        
        # Check NAS storage  
        has_nas = bool(self.nas_audio and os.path.exists(self.nas_audio))
        
        # Check cloud storage (Azure)
        has_cloud = bool(self.audio_url and self.audio_url.startswith('https://'))
        
        return f"{'t' if has_local else 'f'}/{'t' if has_nas else 'f'}/{'t' if has_cloud else 'f'}"


class User(Model):
    id = fields.IntField(pk=True, generated=True)
    first_name = fields.TextField()
    last_name = fields.TextField()
    role = fields.TextField(null=True)

    class Meta:
        table = "user"

    def __str__(self):
        return f"User({self.id}, {self.first_name} {self.last_name})"

    @property
    def full_name(self) -> str:
        """Return full name"""
        return f"{self.first_name} {self.last_name}"


class SpeakerToUser(Model):
    recording_id = fields.IntField()
    speaker_id = fields.IntField()  # e.g., 0, 1, 2
    user_id = fields.IntField()

    class Meta:
        table = "speaker_to_user"
        # Don't use any primary key field
        ordering = ["recording_id", "speaker_id"]

    def __str__(self):
        return f"SpeakerToUser(recording={self.recording_id}, speaker={self.speaker_id}, user={self.user_id})"


class Todo(Model):
    id = fields.IntField(pk=True, generated=True)
    name = fields.TextField()
    desc = fields.TextField(null=True)
    status = fields.TextField(null=True)
    user_id = fields.IntField(null=True)
    created_at_recording_id = fields.IntField(null=True)
    updated_at_recording_id = fields.IntField(null=True)

    class Meta:
        table = "todo"

    def __str__(self):
        return f"Todo({self.id}, {self.name})"

