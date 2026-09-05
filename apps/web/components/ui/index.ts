/**
 * Single export surface for the presentational layer (`components/ui/`).
 *
 * Design firewall: files in this directory are plug-and-play visuals only —
 * no workspace packages, no web lib helpers, no app routes, no server context.
 * Enforced by integration/ui-firewall.test.ts.
 *
 * Primitives land here task-by-task in Phase 1.
 */
export {
  Badge,
  Button,
  Card,
  Delta,
  EmptyState,
  Kicker,
  PageTitle,
  Spinner,
  StatCard,
} from "./primitives";
export type { BadgeTone } from "./primitives";
export {
  Field,
  Input,
  MonthStepper,
  PillToggle,
  Segmented,
  Select,
} from "./forms";
export { AppShell, isNavItemActive, NAV_ICONS } from "./app-shell";
export type { NavItem } from "./app-shell";
export { ThemePicker } from "./theme-picker";
export { RowCardList, Table, TableRow } from "./table";
export { PressureBars } from "./charts";
export {
  IconBank,
  IconCard,
  IconDoc,
  IconDots,
  IconGrid,
  IconHome,
  IconJar,
  IconPencil,
  IconPlusCircle,
  IconSliders,
  IconTag,
  IconTransfer,
  IconTrash,
  IconUpload,
} from "./icons";
export type { IconProps } from "./icons";
export { ToastProvider, useToast } from "./toast";
export type { ToastApi, ToastInput, ToastRecord, ToastTone } from "./toast";
export { SubmitButton } from "./submit-button";
export { NavigationSubmitButton } from "./navigation-submit-button";
export { Skeleton } from "./skeleton";
export { RouteSkeleton } from "./route-skeleton";
export type { RouteSkeletonVariant } from "./route-skeleton";
