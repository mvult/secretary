from textual.app import ComposeResult
from textual import on
from textual.events import Mount
from textual.containers import Container
from textual.widgets import Static, SelectionList
from textual.widgets.selection_list import Selection
from textual.screen import ModalScreen


import logging


class AnalysisModal(ModalScreen):
    """Modal for selecting transcript analysis options"""

    BINDINGS = [
        ("escape", "cancel", "Cancel"),
    ]

    CSS = """
    AnalysisModal {
        align: center middle;
    }
    
    .analysis-dialog {
        width: 60;
        height: 20;
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
                id="analysis-list",
            )


    @on(Mount)
    @on(SelectionList.SelectedChanged)
    def update_selection(self) -> None:
        selected = self.query_one(SelectionList).selected
        logging.info(f"AnalysisModal: selection changed to: {selected}")
        
        # If something is selected and we have exactly one item, trigger analysis
        if selected and len(selected) == 1:
            selected_id = list(selected)[0]
            logging.info(f"AnalysisModal: single item selected, dismissing with: {selected_id}")
            self.dismiss(selected_id)

    def action_cancel(self):
        """Cancel the modal"""
        self.dismiss(None)

