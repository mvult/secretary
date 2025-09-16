from textual.app import ComposeResult
from textual.containers import Container
from textual.widgets import Static, SelectionList
from textual.widgets.selection_list import Selection
from textual.screen import ModalScreen


class AnalysisModal(ModalScreen):
    """Modal for selecting transcript analysis options"""

    BINDINGS = [
        ("escape", "cancel", "Cancel"),
        ("enter", "select", "Select"),
    ]

    CSS = """
    AnalysisModal {
        align: center middle;
    }
    
    .analysis-dialog {
        width: 60;
        height: 15;
        background: $surface;
        border: solid $primary;
        padding: 2;
    }
    
    .dialog-title {
        height: 2;
        margin-bottom: 1;
    }
    
    #analysis-list {
        height: 10;
    }
    """

    def __init__(self, transcript: str):
        super().__init__()
        self.transcript = transcript
        self.selected_analysis = None

    def compose(self) -> ComposeResult:
        with Container(classes="analysis-dialog"):
            yield Static("Choose Analysis:", classes="dialog-title")
            yield SelectionList[str](
                Selection("Extract TODOs", "todos"),
                Selection("Summarize", "summary"),
                id="analysis-list"
            )

    def on_selection_list_option_selected(self, event: SelectionList.OptionSelected) -> None:
        """Handle selection from the list"""
        self.selected_analysis = event.option_id
        self.dismiss(event.option_id)
    
    def action_select(self):
        """Select the currently highlighted option"""
        selection_list = self.query_one("#analysis-list", SelectionList)
        if selection_list.highlighted is not None:
            option = selection_list.get_option_at_index(selection_list.highlighted)
            if option:
                self.dismiss(option.id)
    
    def action_cancel(self):
        """Cancel the modal"""
        self.dismiss(None)