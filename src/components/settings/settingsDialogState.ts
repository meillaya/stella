import { create } from 'zustand'
import { isGatewayBuild, useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 数据管理 / Stella */
export type SettingsSection = 'general' | 'data' | 'stella'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/**
 * 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key。
 * Stella 网关构建在缺少本地 Key 时由网关占位 Key 接管，不强制首次引导；
 * 用户仍可在「数据管理」里填写自己的 Key。
 */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey || isGatewayBuild()) {
    return true
  }
  openSettings('data')
  return false
}
