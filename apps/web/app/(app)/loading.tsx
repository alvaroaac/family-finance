import { RouteSkeleton } from "../../components/ui";

/**
 * Route-level Suspense fallback for the whole `(app)` group — shown while
 * Next streams in any protected page (Resumo, Dashboard, Transações, ...).
 * Calm, on-brand skeleton; no data, no client JS needed.
 */
export default function AppLoading() {
  return <RouteSkeleton variant="default" />;
}
