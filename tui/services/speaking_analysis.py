"""Word-based participation analysis for saved diarized transcripts."""

import re
from collections import Counter


SPEAKER_LABEL = re.compile(r"^\s*Speaker\s+(\d+)\s*:\s*", re.IGNORECASE | re.MULTILINE)
WORD = re.compile(r"\w+(?:['’]\w+)*", re.UNICODE)


def speaking_analysis_text(transcript: str, mappings: list[dict], users: list) -> str:
    users_by_id = {user.id: user for user in users}
    speaker_users = {}
    for mapping in mappings:
        speaker_users.setdefault(mapping["speaker_id"], set()).add(mapping["user_id"])

    counts = Counter()
    names = {("unknown", None): "Unattributed"}

    def add_words(speaker_id, text):
        key = ("unknown", None) if speaker_id is None else ("speaker", speaker_id)
        if speaker_id is not None:
            names[key] = f"Speaker {speaker_id}"
            user_ids = speaker_users.get(speaker_id, set())
            if len(user_ids) == 1:
                user_id = next(iter(user_ids))
                user = users_by_id.get(user_id)
                if user:
                    key = ("user", user_id)
                    names[key] = user.full_name.strip() or f"User {user_id}"
        count = len(WORD.findall(text))
        if count:
            counts[key] += count

    speaker_id = None
    start = 0
    for match in SPEAKER_LABEL.finditer(transcript):
        add_words(speaker_id, transcript[start:match.start()])
        speaker_id = int(match.group(1))
        start = match.end()
    add_words(speaker_id, transcript[start:])

    total = sum(counts.values())
    lines = [
        "Participation by word count (speaking-time proxy; no timing data saved).",
        f"Total: {total:,} words",
        "",
    ]
    if not total:
        return "\n".join(lines + ["No spoken words found."])

    width = max(len("Participant"), *(len(names[key]) for key in counts))
    lines.append(f"{'Participant':<{width}}  {'Words':>8}  {'Share':>6}")
    for key, count in counts.most_common():
        lines.append(f"{names[key]:<{width}}  {count:>8,}  {count / total:>6.1%}")
    if ("unknown", None) in counts:
        lines.extend(["", "Unattributed words have no speaker label in the transcript."])
    return "\n".join(lines)
