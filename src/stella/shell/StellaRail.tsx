import clsx from 'clsx'
import type { MouseEvent } from 'react'
import type { TranslationKey } from '../../i18n/index.js'
import { useTranslate } from '../../i18n/index.js'
import { IconSettingsOutline16 } from '../../components/base/icons.js'
import { Tooltip } from '../../components/base/Tooltip.js'
import { href, navigate, type Route, type RouteName } from '../router.js'
import {
  IconChat,
  IconDatasets,
  IconImprove,
  IconQuality,
  IconRuns,
  IconStar,
  IconTraces,
} from '../ui/icons.js'
import styles from './StellaRail.module.css'

type Section = 'chat' | 'quality' | 'traces' | 'datasets' | 'runs' | 'improve'

const NAV_ITEMS: {
  key: Section
  path: string
  labelKey: TranslationKey
  Icon: typeof IconChat
}[] = [
  { key: 'chat', path: '/chat', labelKey: 'stellaNavChat', Icon: IconChat },
  { key: 'quality', path: '/quality', labelKey: 'stellaNavQuality', Icon: IconQuality },
  { key: 'traces', path: '/traces', labelKey: 'stellaNavTraces', Icon: IconTraces },
  { key: 'datasets', path: '/datasets', labelKey: 'stellaNavDatasets', Icon: IconDatasets },
  { key: 'runs', path: '/runs', labelKey: 'stellaNavRuns', Icon: IconRuns },
  { key: 'improve', path: '/improve', labelKey: 'stellaNavImprove', Icon: IconImprove },
]

/** Detail routes keep their section lit: trace -> Traces, dataset -> Datasets, run/compare -> Runs. */
const SECTION_BY_ROUTE: Partial<Record<RouteName, Section>> = {
  chat: 'chat',
  quality: 'quality',
  traces: 'traces',
  trace: 'traces',
  datasets: 'datasets',
  dataset: 'datasets',
  runs: 'runs',
  run: 'runs',
  compare: 'runs',
  improve: 'improve',
}

const activeSection = (route: Route): Section | undefined => SECTION_BY_ROUTE[route.name]

/** Let the browser own modified clicks; plain clicks stay in the SPA router. */
const onLink = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }
  event.preventDefault()
  navigate(path)
}

/** 52px desktop rail: Stella mark, the six workbench sections, settings at the bottom. */
export const StellaRail = ({ route }: { route: Route }) => {
  const t = useTranslate()
  const active = activeSection(route)
  return (
    <aside className={styles.rail} aria-label={t('stellaNavLabel')}>
      <Tooltip content={t('appName')} placement="bottom">
        <button
          type="button"
          className="st-rail-mark"
          aria-label={t('appName')}
          onClick={() => navigate('/chat')}
        >
          <IconStar size={18} />
        </button>
      </Tooltip>
      <nav className="st-rail-nav" aria-label={t('stellaNavLabel')}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.Icon
          const current = active === item.key
          return (
            <Tooltip key={item.key} content={t(item.labelKey)} placement="bottom">
              <a
                href={href(item.path)}
                className={clsx('st-rail-btn', styles.link)}
                aria-label={t(item.labelKey)}
                aria-current={current ? 'page' : undefined}
                onClick={onLink(item.path)}
              >
                <Icon size={19} />
              </a>
            </Tooltip>
          )
        })}
      </nav>
      <span className="st-rail-spacer" />
      <Tooltip content={t('settings')} placement="bottom">
        <a
          href={href('/settings')}
          className={clsx('st-rail-btn', styles.link)}
          aria-label={t('settings')}
          aria-current={route.name === 'settings' ? 'page' : undefined}
          onClick={onLink('/settings')}
        >
          <IconSettingsOutline16 />
        </a>
      </Tooltip>
    </aside>
  )
}

/** Mobile workbench: the same sections as one horizontally scrollable strip. */
export const StellaMobileNav = ({ route }: { route: Route }) => {
  const t = useTranslate()
  const active = activeSection(route)
  return (
    <nav className={styles.mobileNav} aria-label={t('stellaNavLabel')}>
      <div className={styles.mobileNavScroll}>
        {NAV_ITEMS.map((item) => {
          const current = active === item.key
          return (
            <a
              key={item.key}
              href={href(item.path)}
              className={clsx(styles.mobileNavItem, current && styles.mobileNavItemActive)}
              aria-current={current ? 'page' : undefined}
              onClick={onLink(item.path)}
            >
              {t(item.labelKey)}
            </a>
          )
        })}
      </div>
      <span className={styles.mobileNavRule} aria-hidden />
      <a
        href={href('/settings')}
        className={styles.mobileNavSettings}
        aria-label={t('settings')}
        aria-current={route.name === 'settings' ? 'page' : undefined}
        onClick={onLink('/settings')}
      >
        <IconSettingsOutline16 />
      </a>
    </nav>
  )
}
