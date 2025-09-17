from textual.app import ComposeResult
from textual.containers import Container
from textual.widgets import Static, Input, Button
from textual.screen import ModalScreen
import logging


class RenameModal(ModalScreen):
    """Modal for renaming a recording"""

    CSS = """
    RenameModal {
        align: center middle;
    }
    
    .rename-dialog {
        width: 60;
        height: 13;
        background: $surface;
        border: solid $primary;
        padding: 2;
    }
    
    #rename-input {
        width: 100%;
        height: 3;
        margin: 1 0;
        border: solid $primary;
    }
    """

    def __init__(self, current_name: str):
        super().__init__()
        self.current_name = current_name
        self.new_name = None

    def compose(self) -> ComposeResult:
        with Container(classes="rename-dialog"):
            yield Static("Rename Recording:", classes="dialog-title")
            yield Input(id="rename-input")

    async def on_mount(self) -> None:
        """Set the input value and focus after mount"""
        logging.info(
            f"RenameModal on_mount called with current_name: '{self.current_name}'"
        )
        # Use a timer to set the value after a small delay
        self.set_timer(0.1, self.set_input_value)

    async def set_input_value(self) -> None:
        """Set the input value with a small delay"""
        input_widget = self.query_one("#rename-input", Input)
        logging.info(f"Setting input value (delayed): '{self.current_name}'")
        input_widget.value = self.current_name
        input_widget.select_all()
        input_widget.focus()
        # Force a refresh
        input_widget.refresh()
        logging.info(f"Input value after setting: '{input_widget.value}'")

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "save-btn":
            input_widget = self.query_one("#rename-input", Input)
            self.new_name = input_widget.value.strip()
            self.dismiss(self.new_name)
        else:
            self.dismiss(None)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "rename-input":
            self.new_name = event.input.value.strip()
            self.dismiss(self.new_name)