---
name: <skill-name-kebab>
description: <One sentence. Include trigger conditions explicitly — e.g. "Use when adding a centered modal, bottom sheet, or toast in a RN+Expo app.">
---

> **Complements:** `<authoritative-skill-1>`, `<authoritative-skill-2>`. For *base setup* of <X>, use that skill — this one adds the project-tuned <Y>.

## Authority-preferred default

<State the modern/blessed approach this skill teaches first — e.g. "Use NativeTabs (SDK 55+) for tab navigation; the JS `<Tabs>` variant is a documented secondary option only when you need `tabPress.preventDefault` for gating.">

## Conventions / checklist

<The opinionated rules, sourced from CLAUDE.md. Bullet list. Each rule is a one-liner the consumer can quickly grep.>

## Representative inline snippets

<Short fenced TS/TSX/JSON blocks showing the canonical shape of each pattern. Snippets, not full components — they illustrate the rule. Example:

  ```tsx
  // Sheet pattern: every gorhom BottomSheetModal MUST pass topInset and use
  // BottomSheetFooter for sticky CTAs, padded by Math.max(insets.bottom,12)+8.
  <BottomSheetModal
    topInset={insets.top}
    backdropComponent={SheetBackdrop}
    footerComponent={(p) => (
      <BottomSheetFooter {...p} bottomInset={Math.max(insets.bottom, 12) + 8}>
        …
      </BottomSheetFooter>
    )}
  />
  ```

Snippets live in THIS markdown file. We do NOT bundle `.tsx`/`.ts` files for the consumer to copy — Claude generates the code in-context from these snippets + rules.>

## Heavy patterns (optional)

<If one sub-pattern needs more than ~150 lines to explain (e.g. a Superwall ↔ RC `PurchaseController` bridge, a multi-step state machine), put it in `references/<topic>.md` alongside this `SKILL.md`. Pure markdown. Claude loads on demand. Same convention as building-native-ui's `references/tabs.md`, `references/form-sheet.md`, etc.>

## Adapt for your project

<Bulleted checklist of values the consumer parameterizes when applying the patterns above: color tokens, entitlement ids, env var names, locale list, API base URL. Strip any legal/medical copy specific to a single product.>
