# Bottom sheets — gorhom canonical pattern

Reference for `@gorhom/bottom-sheet` usage. For the basic form sheet pattern, see
`building-native-ui/references/form-sheet.md`.

---

## When to use gorhom vs `Stack.Screen presentation:"formSheet"`

**Reach for `Stack.Screen presentation:"formSheet"` first.** It maps to the native
iOS 17+ detent sheet, has zero JS-layer snap math, and requires no Provider wrapping.
Use it for any sheet that opens as a route (e.g. `router.push("/some-sheet")`).

**Switch to gorhom only when you need at least one of:**

- **Programmatic control from outside the sheet's component tree** — a `useRef` +
  `ref.current?.present()` call from a parent, a list item, or a state machine.
- **Content-driven or custom snap points** — e.g. `["40%", "85%"]` multi-snap, or
  `enableDynamicSizing` so the sheet hugs its content height automatically.
- **A sticky footer that participates in keyboard avoidance** — gorhom's
  `BottomSheetFooter` + `keyboardBehavior="interactive"` keep the CTA pinned above
  the keyboard without any extra KAV boilerplate.
- **Multiple sheets stacked** — gorhom handles z-order; native form sheets do not
  stack reliably on Android.

---

## Setup

Wrap the relevant sub-tree (or the whole app in `_layout.tsx`) with
`BottomSheetModalProvider`:

```tsx
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <BottomSheetModalProvider>
        <Stack />
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}
```

**Use `BottomSheetModal`, not `BottomSheet`**, for any sheet you open imperatively.
`BottomSheet` is for in-flow sheets that are always rendered in the component tree
(e.g. a persistent drawer). `BottomSheetModal` starts hidden and presents on demand
via `ref.current?.present()`, which is the correct model for action sheets, pickers,
and confirmation dialogs.

---

## The five must-haves

### 1. `backdropComponent={SheetBackdrop}`

Always pass the project's shared backdrop component. Never inline
`BottomSheetBackdrop` directly — the shared wrapper hard-codes the correct
`appearsOnIndex`/`disappearsOnIndex` values and `opacity={0.5}` so every sheet
reads as modal (the page behind dims, tapping the scrim closes the sheet).

```tsx
import { SheetBackdrop } from "@/components/ui/sheet-backdrop";

<BottomSheetModal backdropComponent={SheetBackdrop} ... />
```

`SheetBackdrop` is intentionally thin:

```tsx
// src/components/ui/sheet-backdrop.tsx
import { BottomSheetBackdrop, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";

export function SheetBackdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0.5}
      pressBehavior="close"
    />
  );
}
```

### 2. `topInset={insets.top}`

Without this, a tall snap point (e.g. `"85%"`) extends behind the notch/status bar.
Gorhom uses `topInset` to cap the sheet's maximum height so `100%` still sits below
the safe area.

```tsx
import { useSafeAreaInsets } from "react-native-safe-area-context";

const insets = useSafeAreaInsets();

<BottomSheetModal topInset={insets.top} snapPoints={["85%"]} ... />
```

### 3. `appearsOnIndex={0}` + `disappearsOnIndex={-1}` in the backdrop

Gorhom defaults `appearsOnIndex` to `1`, which means the backdrop only appears when
the sheet reaches its **second** snap point. A single-snap sheet never hits index 1,
so the backdrop never shows. `SheetBackdrop` already sets these correctly; if you
ever inline `BottomSheetBackdrop` directly, you must set them explicitly.

```tsx
<BottomSheetBackdrop
  {...props}
  appearsOnIndex={0}   // show when sheet opens (index 0)
  disappearsOnIndex={-1} // hide when sheet is fully closed
/>
```

### 4. Sticky CTA in `BottomSheetFooter`, padded for home indicator

A plain sibling `<View>` below `BottomSheetScrollView` gets pushed below the visible
sheet area when content is long. Always use gorhom's `footerComponent` prop with
`BottomSheetFooter` for any always-visible CTA. Pad the bottom by
`Math.max(insets.bottom, 12) + 8` to clear the home indicator on notched devices
while maintaining minimum spacing on devices without one.

```tsx
import { BottomSheetFooter, type BottomSheetFooterProps } from "@gorhom/bottom-sheet";

const renderFooter = useCallback(
  (props: BottomSheetFooterProps) => (
    <BottomSheetFooter {...props} bottomInset={0}>
      <View
        className="px-4 pt-2 border-t border-border-light bg-surface-card"
        style={{ paddingBottom: Math.max(insets.bottom, 12) + 8 }}
      >
        <Pressable
          onPress={handleSave}
          className="bg-primary rounded-2xl py-4 items-center active:opacity-80"
        >
          <Text className="text-white text-[15px] font-bold">{t("common.save")}</Text>
        </Pressable>
      </View>
    </BottomSheetFooter>
  ),
  [handleSave, insets.bottom, t]
);

<BottomSheetModal footerComponent={renderFooter} ... />
```

Note `bottomInset={0}` on `BottomSheetFooter` itself — the manual `paddingBottom`
math handles the safe area; letting gorhom also add its own inset would double-pad.

### 5. `BottomSheetView` or `BottomSheetScrollView` inside — never a plain `<View>`

Gorhom needs its own scroll/view primitives to intercept pan gestures correctly. A
plain `<View>` breaks gesture handling: the user can scroll the list but the sheet
won't respond to the drag, so pan-to-dismiss stops working mid-list.

```tsx
import { BottomSheetScrollView, BottomSheetView } from "@gorhom/bottom-sheet";

// Fixed-height content (e.g. a confirmation dialog):
<BottomSheetModal enableDynamicSizing>
  <BottomSheetView className="px-4 pt-2"
    style={{ paddingBottom: Math.max(insets.bottom, 12) + 8 }}
  >
    {/* content */}
  </BottomSheetView>
</BottomSheetModal>

// Scrollable content (e.g. a long list):
<BottomSheetModal snapPoints={["85%"]}>
  <BottomSheetScrollView className="flex-1 px-4">
    {/* list items */}
    <View className="h-28" /> {/* spacer so last item clears the sticky footer */}
  </BottomSheetScrollView>
</BottomSheetModal>
```

When using a sticky footer, add a trailing spacer (`<View className="h-28" />`) at
the bottom of `BottomSheetScrollView` so the last row is not obscured by the footer.

---

## Keyboard handling

```tsx
<BottomSheetModal
  keyboardBehavior="interactive"
  keyboardBlurBehavior="restore"
  ...
/>
```

`keyboardBehavior="interactive"` makes the sheet slide up with the keyboard as the
user types, keeping the focused input visible. `keyboardBlurBehavior="restore"` snaps
the sheet back to its snap point when the keyboard is dismissed, instead of staying at
the elevated position. The sticky `BottomSheetFooter` composes with this correctly —
it stays pinned above the keyboard without any manual KAV wrapping.

---

## Programmatic control

```tsx
import { useRef, useCallback } from "react";
import { BottomSheetModal } from "@gorhom/bottom-sheet";

const sheetRef = useRef<BottomSheetModal>(null);

const open = useCallback(() => sheetRef.current?.present(), []);
const close = useCallback(() => sheetRef.current?.dismiss(), []);

// In JSX:
<Pressable onPress={open}>
  <Text>{t("common.open")}</Text>
</Pressable>

<BottomSheetModal ref={sheetRef} snapPoints={["50%"]} backdropComponent={SheetBackdrop}>
  ...
</BottomSheetModal>
```

**Anti-pattern: `visible` boolean state.** Do not track sheet visibility with a
boolean and conditionally render `{visible && <BottomSheetModal ...>}`. Sheets are
imperative — they have internal animation state that must persist between opens.
Unmounting on close throws away that state and causes a flash on re-mount. Use `ref`
exclusively; let the sheet manage its own visibility.

---

## Common pitfalls

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| Sheet drifts behind the notch / status bar | `topInset` missing | Add `topInset={insets.top}` |
| Sticky footer pushed off-screen when content is long | Footer is a plain sibling `<View>`, not in `BottomSheetFooter` | Move CTA into `footerComponent` render prop |
| Backdrop never appears on a single-snap sheet | `appearsOnIndex` defaults to `1`; sheet never reaches index 1 | Use `SheetBackdrop` (sets `appearsOnIndex={0}`) |
| Tapping the scrim does not close the sheet | `pressBehavior` is missing or set to `"none"` | `SheetBackdrop` already sets `pressBehavior="close"` |
| CTA obscures the last list item | Spacer missing at the end of `BottomSheetScrollView` | Add `<View className="h-28" />` as the last child |
| Pan-to-dismiss stops working inside a scroll | Content is in a plain `<View>` or `<ScrollView>` | Replace with `BottomSheetView` / `BottomSheetScrollView` |

---

## Full canonical example

```tsx
import { View, Text, Pressable } from "react-native";
import { useRef, useCallback } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetFooter,
  type BottomSheetFooterProps,
} from "@gorhom/bottom-sheet";
import { useTranslation } from "react-i18next";
import { SheetBackdrop } from "@/components/ui/sheet-backdrop";

// --- trigger site (parent component) ---
const sheetRef = useRef<BottomSheetModal>(null);
const openSheet = useCallback(() => sheetRef.current?.present(), []);

// --- sheet component ---
export function ExampleSheet() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  const renderFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props} bottomInset={0}>
        <View
          className="px-4 pt-2 border-t border-border-light bg-surface-card"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 8 }}
        >
          <Pressable
            onPress={() => sheetRef.current?.dismiss()}
            className="bg-primary rounded-2xl py-4 items-center active:opacity-80"
          >
            <Text className="text-white text-[15px] font-bold">{t("common.confirm")}</Text>
          </Pressable>
        </View>
      </BottomSheetFooter>
    ),
    [insets.bottom, t]
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={["85%"]}
      topInset={insets.top}
      backdropComponent={SheetBackdrop}
      footerComponent={renderFooter}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      enablePanDownToClose
    >
      <BottomSheetScrollView className="flex-1 px-4">
        {/* list items */}
        <View className="h-28" />
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
```

---

## When to migrate back to `Stack.Screen presentation:"formSheet"`

If, after building the sheet, you find you are not using any of:

- A `useRef` + `present()` trigger from outside the sheet tree
- `BottomSheetFooter` for a sticky CTA
- Multi-snap points or `enableDynamicSizing`
- Multiple stacked sheets

...then the gorhom overhead is not justified. Replace with a route pushed via
`router.push()` and decorated with:

```tsx
// app/my-sheet.tsx
export const unstable_settings = { presentation: "formSheet" };
```

This renders as a native detent sheet on iOS 17+ with no Provider, no ref, and no
snap-point math. It is smoother on iOS and simpler to test. The cost is that you
cannot control it imperatively from an unrelated component.
