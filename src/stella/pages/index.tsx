import type { Route } from '../router.js'
import { DatasetDetailPage, DatasetsPage } from './datasets.js'
import { ImprovePage } from './improve.js'
import { NotFoundPage } from './notfound.js'
import { QualityPage } from './quality.js'
import { ComparePage, RunDetailPage, RunsPage } from './runs.js'
import { SettingsPage } from './settings.js'
import { TraceDetailPage, TracesPage } from './traces.js'
import '../workbench/workbench.css'

/**
 * Route-level workbench entry point. The shell owns the rail and the chat
 * surface; this component renders only the workbench routes.
 */
export const WorkbenchRoute = ({ route }: { route: Route }) => {
  switch (route.name) {
    case 'quality':
      return <QualityPage />
    case 'traces':
      return <TracesPage />
    case 'trace':
      return <TraceDetailPage traceId={route.id} />
    case 'datasets':
      return <DatasetsPage />
    case 'dataset':
      return <DatasetDetailPage datasetId={route.id} />
    case 'runs':
      return <RunsPage openNew={route.query.get('new') === '1'} />
    case 'run':
      return <RunDetailPage runId={route.id} />
    case 'compare':
      return (
        <ComparePage
          initialBaseline={route.query.get('baseline') ?? ''}
          initialCandidate={route.query.get('candidate') ?? ''}
        />
      )
    case 'improve':
      return <ImprovePage />
    case 'settings':
      return <SettingsPage />
    case 'notfound':
      return <NotFoundPage path={route.path} />
    default:
      return <NotFoundPage path={route.path} />
  }
}
