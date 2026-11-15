import { href } from '../router.js'
import { Card, EmptyState, Page, PageHeader } from '../ui/index.js'
import { IconChat, IconQuality } from '../ui/icons.js'
import { WorkLink } from '../workbench/components.js'

export const NotFoundPage = ({ path }: { path?: string }) => (
  <Page className="st-w-page">
    <PageHeader
      title="Page not found"
      description="This hash route does not match a workbench page."
      actions={<WorkLink href={href('/chat')}>Open chat</WorkLink>}
    />
    <Card>
      <EmptyState
        icon={<IconQuality size={18} />}
        title="Nothing lives at this address"
        description={
          path
            ? `Stella could not resolve ${path}. Pick a workbench page from the rail, or return to chat.`
            : 'Pick a workbench page from the rail, or return to chat.'
        }
        action={
          <div className="st-w-inline-actions">
            <WorkLink href={href('/quality')} variant="primary">
              <IconQuality size={14} />
              Quality
            </WorkLink>
            <WorkLink href={href('/chat')}>
              <IconChat size={14} />
              Open chat
            </WorkLink>
          </div>
        }
      />
    </Card>
  </Page>
)
