from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from textual.app import App
from textual.widgets import TextArea

from services.speaking_analysis import speaking_analysis_text
from ui.recording_detail_screen import RecordingDetailScreen


class SpeakingAnalysisTests(unittest.TestCase):
    def test_counts_turns_and_continuations_and_merges_participant(self):
        text = speaking_analysis_text(
            "Speaker 0: Hello there.\nI’m here.\n\n"
            "Speaker 1: Sí, bien.\nSpeaker 2: One more.\nSpeaker 0: Goodbye.",
            [{"speaker_id": speaker, "user_id": 7} for speaker in (0, 2)],
            [SimpleNamespace(id=7, full_name="Alex Smith")],
        )
        self.assertIn("Total: 9 words", text)
        self.assertRegex(text, r"Alex Smith\s+7\s+77\.8%")
        self.assertRegex(text, r"Speaker 1\s+2\s+22\.2%")

    def test_unlabeled_words_and_ambiguous_mapping_stay_unattributed(self):
        text = speaking_analysis_text(
            "Opening words.\nSpeaker 0: Three more words.",
            [{"speaker_id": 0, "user_id": user} for user in (1, 2)],
            [SimpleNamespace(id=1, full_name="Alex")],
        )
        self.assertRegex(text, r"Unattributed\s+2\s+40\.0%")
        self.assertRegex(text, r"Speaker 0\s+3\s+60\.0%")
        self.assertNotIn("Alex", text)
        self.assertIn("Unattributed", speaking_analysis_text("No labels here", [], []))
        self.assertIn("No spoken words", speaking_analysis_text("Speaker 0: ...", [], []))


class SpeakingViewTests(unittest.IsolatedAsyncioTestCase):
    async def test_view_appears_after_transcription_and_cycles_and_copies(self):
        recording = SimpleNamespace(
            name="Meeting", created_at_formatted="Today",
            storage_status_readable="Local yes", transcript=None, summary=None,
        )
        screen = RecordingDetailScreen(1)
        with (
            patch("ui.recording_detail_screen.RecordingService.get_recording_by_id", AsyncMock(return_value=recording)),
            patch("ui.recording_detail_screen.AnalysisService.get_output_status", AsyncMock(return_value={"transcript": False})),
            patch("ui.recording_detail_screen.AnalysisService.get_analysis_status", AsyncMock(return_value="None")),
            patch("ui.recording_detail_screen.TodoService.get_todos_by_recording", AsyncMock(return_value=[])),
            patch("ui.recording_detail_screen.SpeakerService.get_speaker_mappings", AsyncMock(return_value=[])),
        ):
            app = App()
            async with app.run_test() as pilot:
                await app.push_screen(screen)
                await screen.update_display()
                self.assertNotIn("speaking", screen._available_views)
                recording.transcript = "Speaker 0: Hello world."
                await screen.update_display()
                await pilot.press("down")
                self.assertEqual(screen.active_view, "speaking")
                self.assertIn("100.0%", screen.query_one("#analysis-text", TextArea).text)
                with patch.object(screen, "_copy_to_clipboard", return_value=True) as copy:
                    await pilot.press("y")
                    self.assertIn("100.0%", copy.call_args.args[0])
                await pilot.press("up")
                self.assertEqual(screen.active_view, "transcript")
