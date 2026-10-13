# IntelliFleet — Web App

## Install & Run
```bash
pip install flask
python app.py
```
Then open: http://localhost:5000

## File Structure
```
intellifleet_web/
├── app.py                  ← Flask backend + simulation engine
├── requirements.txt
├── templates/
│   └── index.html          ← Full UI (HTML/CSS)
└── static/
    └── js/
        └── simulation.js   ← Canvas renderer + API polling
```

## Features
- Live 20×20 canvas simulation at ~6fps
- Click any empty cell to drop a dynamic obstacle
- Toggle SIM / HEAT (traffic heatmap) views
- Adjust robot count and spawn rate live
- Hover cells to inspect type, visit count, and robot info
- Real-time KPI dashboard sidebar
- Activity log with state change tracking
