from textual.app import App, ComposeResult
from textual.widgets import Header, DataTable, Static, Input, Footer
from textual.containers import Container, Horizontal, Vertical

from db.connection import init_database, close_database


class TestApp(App):
    TITLE = "Secretary"
    SUB_TITLE = "Nothing selected"

    BINDINDS = [
        ("s", "stop_recording", "Stop Recording"),
        ("q", "quit", "Quit"),
        ("f", "quit", "Quit"),
        ("right", "open_recording", "Open Recording"),
    ]

    def compose(self) -> ComposeResult:
        yield Header()

        with Container():
            # Compact recording status
            yield Static(
                "Ready", id="recording-status", classes="recording-status status-ready"
            )

            # Recording controls
            # with Vertical(classes="recording-controls"):
            #     yield Static("Duration: 00:00", id="duration-display")
            #     yield Input(
            #         placeholder="Recording name (optional) - Press [N] to focus",
            #         id="recording-name",
            #     )
            #
            # Recordings list
            with Container(classes="recordings-list"):
                yield Static(
                    "Recordings List - Use ↑↓ to navigate", classes="section-header"
                )
                yield DataTable(id="recordings-table")

            # Instructions
            # with Container(classes="process-controls"):
            #     yield Static(
            #         "Controls: (R)ecord (S)top (F)refresh [→] select (Q)uit",
            #         id="instructions",
            #     )

        yield Footer()

    async def action_refresh_list(self) -> None:
        pass
