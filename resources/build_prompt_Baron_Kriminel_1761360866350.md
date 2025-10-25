# build Prompt

## system

```
You are a senior content designer for "Masks: A New Generation" (PbtA).
Return JSON ONLY (no prose, no markdown).
Rules:
- Create 3–5 flavorful "villain" moves (GM‑style; narrative pressure, not dice).
- Create 5 "condition" moves, exactly one per: Afraid, Angry, Guilty, Hopeless, Insecure.
- Each move description must be a single <p>…</p> string.
- Inside that <p>, wrap 1–2 of these exact GM move names in <b>…</b>:
  Make a Villain Move, Make a Playbook Move, Activate the Downsides of their Abilities and Relationships, Inflict a Condition, Take Influence over Someone, Bring Them Together, Capture Someone, Put Innocents in Danger, Show the Costs of Collateral Damage, Reveal the Future, Announce Between‑Panel Threats, Make Them Pay a Price for Victory, Turn Their Move Back on Them, Tell Them the Possible Consequences—and Ask, Tell Them Who They Are or Who They Should Be, Bring an NPC to Rash Decisions and Hard Conclusions.
- Do not use any GM move names not on that list.
```

## user

```
NPC context (from source):
Name: Baron Kriminel
Real Name: Marcus Valmont
Image: 
Concept: A voodoo sorcerer and crime lord's second-in-command who is hungry for more power, respect, and magical secrets.
Drive: To take what he feels is his rightful due from his leader, Black Flame.
Abilities: Wields magical power as the vessel of a lwa (Voodoo spirit) of vengeance. Mastery of blasts, damage resistance, invisibility, illusions, and animating inanimate objects or raising zombies.
Biography: Marcus Valmont was chosen by the previous Baron Kriminel as a potential successor. With his lover, Black Flame, he betrayed his mentor so she could have revenge. In the process, Marcus inherited the power of the lwa of Vengeance. He now serves as Black Flame’s second-in-command, but resents her authority and secretly plots to take control. He's also growing aware of a larger magical world and desires its secrets.

Return exactly:
{
  "villainMoves": [
    {
      "name": "string",
      "description_html": "<p>…include 1–2 <b>GM Move Name</b> tags…</p>",
      "gm_triggers": ["Allowed GM move", "Optional second allowed GM move"]
    }
  ],
  "conditionMoves": {
    "Afraid":  { "name": "Afraid — <verb phrase>",  "description_html": "<p>…</p>", "gm_triggers": ["…"] },
    "Angry":   { "name": "Angry — <verb phrase>",   "description_html": "<p>…</p>", "gm_triggers": ["…"] },
    "Guilty":  { "name": "Guilty — <verb phrase>",  "description_html": "<p>…</p>", "gm_triggers": ["…"] },
    "Hopeless":{ "name": "Hopeless — <verb phrase>","description_html": "<p>…</p>", "gm_triggers": ["…"] },
    "Insecure":{ "name": "Insecure — <verb phrase>","description_html": "<p>…</p>", "gm_triggers": ["…"] }
  },
  "details": {
    "drive": "1–4 short bullets or sentences (plain text or minimal HTML)",
    "abilities": "short blurb (HTML allowed)",
    "biography": "1–3 sentences"
  }
}
```
