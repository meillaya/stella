import type { Route } from '../router.js'
import { EmptyState, Page } from '../ui/index.js'

/**
 * Route-level workbench entry point. The full pages (Quality, Traces, Datasets,
 * Runs, Improve) are implemented by the workbench workstream; this stub keeps
 * the shell compileable while they land.
 */
export const WorkbenchRoute = ({ route }: { route: Route }) => (
  <Page>
    <EmptyState
      title={`${route.name} is being built`}
      description="The workbench page for this route has not landed yet. The chat and gateway continue to run."
    />
  </Page>
)
