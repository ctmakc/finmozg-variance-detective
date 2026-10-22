# DESIGN — FINMOZG Variance Detective (UI)

Subject & audience: a controller at month-end close (and the owner reading the memo) · Page job: ask "why did margin move?", watch the agents work, read a memo where every number opens to its rows.
Direction: **WORKPAPER AT NIGHT** — the auditor's columnar working paper, read under a desk lamp. Grounded in the controller's real artifacts: 14-column analysis pads, audit tick marks in coloured pencil, the double rule under a footed total, red pencil for what does not tie.
Unexpected pairing / risk taken: a Clarendon slab (Besley) — the face of old account books and bank ledgers — on a dark product UI; accounting conventions (tick marks, footing rules, struck lines) used as the UI's state language instead of badges.
Palette (cool, dark by owner preference):
- `--pad` `#0E1714` green-black working paper (page)
- `--pad-raised` `#13201C` (panels) · `--rule` `#22322D` column rules · `--rule-strong` `#34473F`
- `--ink` `#E6E2D3` figures and text (never #fff) · `--ink-dim` `#9CA79F`
- `--tick` `#8DD3AE` verified-tick pencil (agreed to source / cross-system)
- `--redpencil` `#F06A4D` Skeptic's red pencil (vetoes, struck hypotheses, unfavourable bars) — accent, ≤3 per viewport outside the bridge
- `--lamp` `#E9C46A` used once: the live run indicator
Type: Besley 600/800 (display, figures in headlines) + Work Sans 400/500/600 (UI) + Fragment Mono 400 (every amount, SQL, ids; tabular). Scale 1.25; display tracking −0.02em; body 15–16px.
Layout primitive: **the ruled ledger row** — label · amount · pp · ticks · bar, on visible column rules. The timeline, the bridge, findings, hypotheses and memory are all ledger rows. No cards-with-shadows.
Motion personality: pencil — strokes draw (stroke-dashoffset 360–520ms, `cubic-bezier(.65,0,.35,1)`), bars grow from the zero line, the total's double rule draws last; new log rows slide in 140ms; nothing loops except the lamp dot while a run is live. `prefers-reduced-motion`: everything static.
Signature element: **audit tick marks** drawn per finding (✓ agreed to rows, ⊕ cross-system GL·AP·Bank, ∑ ties to bridge), the **red-pencil strike** through rejected hypotheses, and the **double footing rule** under the margin bridge total.
Ledger check: differs from wallet-audit (#0C1A14) on font, accent, signature, motion; from LifeCapital CRM (#0F1412) on font, accent, signature, motion; from regserv plan (#0F1513) on font, accent, signature; from accountingos (light doc gray, Plex, oxblood seal) on 5/5.
Forbidden here: shadows on panels, gradients, glass, rounded >4px, badge pills over headlines, centered hero, uniform fade-ups, any second accent hue.
