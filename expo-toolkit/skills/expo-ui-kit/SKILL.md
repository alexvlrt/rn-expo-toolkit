---
name: expo-ui-kit
description: "Use when adding or normalizing UI primitives in a RN+Expo app — modals, bottom sheets, toasts, cards, buttons, progress bars, icon styling, safe-area handling. Enforces a single AppModal/SheetBackdrop pattern, the topInset + footer math for sheets, NativeWind className-only styling, Lucide-only icons, and Reanimated 4 animation idioms (avoid shared values for press feedback, avoid animating layout properties)."
---

Complements `building-native-ui` (Software Mansion New-Arch patterns; this skill adds
normalized modal/sheet/toast primitives and the safe-area conventions encoded below),
`react-native-best-practices` (Reanimated/Worklets correctness), `expo-tailwind-setup`
(base NativeWind v5 — this skill assumes NativeWind v4 or v5 and stays color-token-agnostic),
and `ui-ux-pro-max` (design system primitives).

---

## Authority-preferred defaults

- **Navigation tabs:** `expo-router/unstable-native-tabs` (`NativeTabs`, SDK 55+) is the default.
  Use JS `<Tabs>` only when you need `tabPress.preventDefault` for a custom gate (e.g. a
  premium-only tab that redirects free users to a paywall before the screen ever renders).
- **Modal-as-screen:** `Stack.Screen presentation:"formSheet"` is the default for any screen
  that slides in over the stack. `@gorhom/bottom-sheet` (`BottomSheetModal`) is a secondary,
  justified when you need programmatic open/close, custom snap math, or a sticky CTA that
  participates in keyboard avoidance.
- **Inline centered modals:** a single shared `AppModal` for the whole app. Never write a
  bespoke `<Modal>` with its own scrim — all centered modals share the same width, padding,
  typography, and backdrop behavior.
- **Tailwind:** NativeWind v5 + Tailwind v4 CSS-first if starting fresh. NativeWind v4 +
  Tailwind 3.x is acceptable if already adopted in the project.

---

## Conventions / checklist

- **className-only styling.** All static styling via `className`. Use `style={{}}` ONLY for
  dynamic values that NativeWind cannot drive: `useAnimatedStyle` transforms, runtime insets
  from `useSafeAreaInsets`, programmatic colors.
- **Color tokens only.** No inline hex on static elements — every color must come from a token
  defined in `tailwind.config.ts` (e.g. `text-primary`, `bg-surface-card`, `text-on-surface-medium`).
- **Icons: Lucide only.** Import from `lucide-react-native`. No `@expo/vector-icons`, no
  `react-native-vector-icons`, no emojis as UI elements. Use `iconWithClassName` (barrel helper)
  to enable `className` styling via `cssInterop`.
- **Centered modals: use `AppModal`.** Sub-components: `AppModalTitle`, `AppModalBody`,
  `AppModalActions`, `AppModalPrimaryCTA`, `AppModalGhostCTA`, `AppModalDestructiveCTA`,
  `AppModalIconHalo`. Dimensions: `max-w-[360px]`, `rounded-3xl`, `px-6 py-7`. Backdrop:
  `bg-black/50`. Tap-to-dismiss unless `loading={true}`. Same dimensions/padding/typography
  across the whole app — never bespoke.
- **`ConfirmModal` wraps `AppModal`.** Never write a standalone `<Modal>` with its own scrim just to confirm a destructive action.
- **Sheets — five must-haves:** `backdropComponent={SheetBackdrop}`, `topInset={insets.top}`, sticky CTAs in `BottomSheetFooter` with `paddingBottom: Math.max(insets.bottom, 12) + 8`, `BottomSheetView`/`BottomSheetScrollView` for content (never a plain `<View>`). Never a sibling `<View>` footer.
- **`SheetBackdrop` props:** `opacity={0.5}`, `pressBehavior="close"`, `appearsOnIndex={0}`, `disappearsOnIndex={-1}`. Gorhom defaults assume multi-snap and never show the scrim on single-snap sheets.
- **Toast: imperative Zustand store.** `show(msg, subMsg?)` / `hide()`. Single `<Toast />` at app root; `pointerEvents="box-none"`; `paddingTop: insets.top + 8`; auto-dismiss 2.6 s. Not a `<Modal>` — never conflicts with open sheets/modals.
- **Press feedback: CSS transition, not shared value.** `useState(pressed)` + `style={{ transform:[{scale: pressed ? 0.96:1}], transitionProperty:["transform"], transitionDuration:120 }}`. See snippet below.
- **Never animate layout properties.** `width`/`height`/`top`/`left` → per-frame layout pass → jank. Use `transform: scaleX` + `transformOrigin: "left"` for fill bars.
- **Worklet directive:** auto-applied by `useAnimatedStyle`/`withSpring`/`withTiming`. Never add `"worklet"` manually inside those callbacks.
- **Skia static charts:** `Skia.Path` rebuild per render is OK for low-update-rate visuals; use `usePathValue` for animated paths.
- **Provider tree order:** `GestureHandlerRootView` → `I18nextProvider` → `SafeAreaProvider` → `QueryClientProvider` → `Stack`. Init order: i18n → auth → Sentry/PostHog → RC → Superwall.

---

## Snippets

### AppModal skeleton

```tsx
// Normalized: max-w-[360px], rounded-3xl, px-6 py-7, bg-surface-card.
// loading=true blocks dismiss (use during in-flight operations).
export function AppModal({ visible, onClose, loading = false, keyboardAvoiding = false, children }: Props) {
  const inner = (
    <Pressable className="flex-1 bg-black/50 items-center justify-center px-6"
               onPress={loading ? undefined : onClose}>
      <Pressable onPress={(e) => e.stopPropagation()} className="w-full max-w-[360px]">
        <View className="bg-surface-card rounded-3xl px-6 py-7">{children}</View>
      </Pressable>
    </Pressable>
  );
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={loading ? undefined : onClose}>
      {keyboardAvoiding
        ? <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1">{inner}</KeyboardAvoidingView>
        : inner}
    </Modal>
  );
}
// Sub-components (all normalized — do not override per call-site):
//   AppModalTitle        text-[18px] font-extrabold text-on-surface
//   AppModalBody         text-[14px] text-on-surface-medium leading-[20px]
//   AppModalActions      flex-row justify-end mt-5 gap-2
//   AppModalPrimaryCTA   bg-primary h-12 rounded-xl text-[15px] font-extrabold white
//   AppModalGhostCTA     px-4 h-12 text-[14px] font-semibold text-on-surface-medium
//   AppModalDestructiveCTA  bg-alert-accent h-12 rounded-xl
//   AppModalIconHalo     w-16 h-16 rounded-full bg-surface-accent, self-center mb-4
```

### SheetBackdrop — drop-in for every gorhom sheet

```tsx
import { BottomSheetBackdrop, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";

// Pass as backdropComponent on every BottomSheet / BottomSheetModal.
// Single-snap sheets open at index 0 — gorhom defaults (appearsOnIndex=1) would never show the scrim.
export function SheetBackdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      opacity={0.5}
      pressBehavior="close"
      appearsOnIndex={0}
      disappearsOnIndex={-1}
    />
  );
}
```

### Sheet with sticky footer (canonical)

```tsx
const insets = useSafeAreaInsets();

const renderFooter = useCallback(
  (props: BottomSheetFooterProps) => (
    <BottomSheetFooter {...props} bottomInset={0}>
      {/* opaque card so content doesn't show through; pb clears home indicator */}
      <View className="px-4 pt-2 border-t border-border-light bg-surface-card"
            style={{ paddingBottom: Math.max(insets.bottom, 12) + 8 }}>
        <Pressable onPress={handleSave} className="bg-primary rounded-2xl py-4 items-center">
          <Text className="text-white text-[15px] font-bold">{t("action.save")}</Text>
        </Pressable>
      </View>
    </BottomSheetFooter>
  ),
  [handleSave, insets.bottom, t],
);

// Imperative primitive — open via `sheetRef.current?.present()`, dismiss via `.dismiss()`.
// (See references/sheets.md for the `BottomSheetModal` vs `BottomSheet` distinction.)
return (
  <BottomSheetModal ref={sheetRef} snapPoints={["85%"]}
    topInset={insets.top}   {/* % snap points are relative to screen height; topInset shifts the ceiling below the notch */}
    enablePanDownToClose onDismiss={onClose}
    backdropComponent={SheetBackdrop} footerComponent={renderFooter}>
    <BottomSheetScrollView className="flex-1 px-4">
      {/* ... content ... */}
      <View className="h-28" /> {/* spacer so last item isn't hidden under the footer */}
    </BottomSheetScrollView>
  </BottomSheetModal>
);
```

### Press feedback — CSS transition, not shared value

```tsx
// Per react-native-best-practices §"CSS Transitions for simple gesture feedback":
// useState + RN transitionProperty is enough; a shared value adds overhead for this.
function ScaleButton({ onPress, children }: { onPress: () => void; children: React.ReactNode }) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={onPress}
      style={{
        transform: [{ scale: pressed ? 0.96 : 1 }],
        transitionProperty: ["transform"],
        transitionDuration: 120,
      }}
    >
      {children}
    </Pressable>
  );
}
```

### Progress bar with scaleX (never animate width)

```tsx
// Source: progress-bar.tsx — animates transform: scaleX instead of width to avoid
// a per-frame layout pass. transformOrigin: "left" anchors the fill to the left edge.
const pct = Math.min(value / max, 1);
const animatedStyle = useAnimatedStyle(() => ({
  transform: [{ scaleX: withTiming(pct, { duration: 600 }) }],
}));

return (
  <View className={`h-2 rounded-full bg-border-light overflow-hidden ${className}`}>
    <Animated.View
      style={[
        { backgroundColor: colorMap[color], height: "100%", width: "100%",
          borderRadius: 9999, transformOrigin: "left" },
        animatedStyle,
      ]}
    />
  </View>
);
```

### Toast pattern — imperative Zustand store

```tsx
// Store (toast-store.ts): lightweight, no Modal, no portal — mounted once at root.
export const useToastStore = create<ToastState>((set) => ({
  visible: false,
  message: "",
  subMessage: undefined,
  show: (message, subMessage) => set({ visible: true, message, subMessage }),
  hide: () => set({ visible: false }),
}));

// Call from anywhere — no hook, no context:
useToastStore.getState().show(t("prefs.saved"), t("prefs.saved_sub"));

// <Toast /> mounted once in app/_layout.tsx. Key properties:
//   pointerEvents="box-none" — never blocks touches outside the banner
//   paddingTop: insets.top + 8 — positions under the status bar
//   MotiView entering/exiting — slide-in from top, auto-dismiss at 2600 ms
//   Pressable onPress={hide} — tap-to-dismiss early
//   z-50 absolute — floats above all content, including open modals/sheets
```

### Icon styling with cssInterop (Lucide + NativeWind)

```tsx
// icon-with-class-name.tsx — call once per icon at module level (not per render).
import { cssInterop } from "nativewind";
import type { LucideIcon } from "lucide-react-native";

export function iconWithClassName(icon: LucideIcon): LucideIcon {
  cssInterop(icon, {
    className: { target: "style", nativeStyleToProp: { color: true, width: true, height: true } },
  });
  return icon;
}

// Icons barrel (src/lib/icons.ts):
import { X, CheckCircle2 } from "lucide-react-native";
export const XIcon = iconWithClassName(X);          // <XIcon className="text-on-surface-low" size={18} />
export const CheckCircle2Icon = iconWithClassName(CheckCircle2);
```

---

## Heavy patterns

The full gorhom setup — `BottomSheetModalProvider`, multi-snap points, keyboard avoidance
inside a sheet, nested sheets, programmatic `ref.current?.present()` / `.dismiss()` lifecycle,
and migration guidance back to `formSheet` — is dense enough to live in overflow. See
`references/sheets.md` (Task 2) for the complete treatment. The snippets above cover the 80 %
case; read the reference when you need programmatic control or encounter the common pitfalls
(sheet drifts under notch, footer off-screen, backdrop missing on single-snap).

---

## Adapt for your project

- **Color tokens** — replace `primary`, `surface-card`, `border-light`, `on-surface`, `alert-accent` with your `tailwind.config.ts` names.
- **Modal max-width** — the example anchors at `360px`; match your design's width anchor.
- **Footer math** — `Math.max(insets.bottom, 12) + 8`: `12` = min clearance above home indicator, `+ 8` = breathing room. Tune to your rhythm.
- **Toast position** — `paddingTop: insets.top + 8` = below status bar. Adjust if you have a custom top bar.
- **Toast duration** — `2600 ms` for two-line messages; `2000` for single-line confirmations.
- **Icon barrel** — `cssInterop` all Lucide icons once in a barrel file; import from there everywhere (tree-shaking still works per icon).
