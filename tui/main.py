#!/usr/bin/env python3
"""
Secretary TUI Application Entry Point
"""

import asyncio
import sys
import os

# Add the current directory to Python path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ui.main_app import RecordingApp
from ui.test_app import TestApp


def main():
    """Main entry point for the TUI application"""
    # app = RecordingApp()
    app = TestApp()
    app.run()


if __name__ == "__main__":
    main()
