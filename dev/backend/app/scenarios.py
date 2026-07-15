from typing import Any


SCENARIOS: dict[str, dict[str, Any]] = {
    "SCN-001": {
        "id": "SCN-001",
        "version": "1.0",
        "persona": "Maria",
        "role": "Synthetic patient",
        "context": "Maria has learned that her condition is worsening and wants to understand what happens next.",
        "startingEmotion": "Sad and scared, trying to remain composed",
        "estimatedMinutes": 6,
        "trainingFocus": "Recognizing fear, validating emotion, and responding clearly",
        "expression": "sad-composed",
        "opening": "I'm trying to hold it together, but I'm scared. I keep wondering what happens next and whether I'm going to suffer.",
        "concerns": ("fear", "scared", "suffer", "pain", "alone", "what happens next"),
    },
    "SCN-002": {
        "id": "SCN-002",
        "version": "1.0",
        "persona": "Daniel",
        "role": "Synthetic family member",
        "context": "Daniel's parent is declining while relatives disagree about the direction of care.",
        "startingEmotion": "Anxious, frustrated, and protective",
        "estimatedMinutes": 6,
        "trainingFocus": "De-escalation, direct acknowledgment, and checking understanding",
        "expression": "frustrated",
        "opening": "Everyone keeps talking around us. My family is arguing, and I need to know whether anyone is really listening to what my parent wanted.",
        "concerns": ("parent", "wishes", "listening", "family", "disagree", "answer"),
    },
    "SCN-003": {
        "id": "SCN-003",
        "version": "1.0",
        "persona": "Aisha",
        "role": "Synthetic patient",
        "context": "Aisha feels overwhelmed after receiving a confusing explanation full of unfamiliar terms.",
        "startingEmotion": "Confused, guarded, and embarrassed to ask again",
        "estimatedMinutes": 5,
        "trainingFocus": "Plain language, jargon repair, and psychological safety",
        "expression": "guarded",
        "opening": "I nodded before, but honestly, I didn't understand most of that explanation. I feel embarrassed asking you to start over.",
        "concerns": (
            "understand",
            "confused",
            "explain",
            "simple",
            "words",
            "start over",
        ),
    },
}


PUBLIC_SCENARIO_FIELDS = {
    "id",
    "version",
    "persona",
    "role",
    "context",
    "startingEmotion",
    "estimatedMinutes",
    "trainingFocus",
    "expression",
}


def public_scenarios() -> list[dict[str, Any]]:
    return [
        {key: value for key, value in scenario.items() if key in PUBLIC_SCENARIO_FIELDS}
        for scenario in SCENARIOS.values()
    ]
