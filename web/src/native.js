// Native-only helpers for the Android / iOS app (Capacitor): system notifications and haptics.
// In a browser these are no-ops; the app falls back to in-app notes and navigator.vibrate.
import { Capacitor } from '@capacitor/core'

const native = Capacitor.isNativePlatform()
let LN = null, HP = null
const ln = async () => (LN ||= (await import('@capacitor/local-notifications')).LocalNotifications)
const hp = async () => (HP ||= (await import('@capacitor/haptics')))

let lastSig = ''
const MSNative = {
  native,
  platform: Capacitor.getPlatform(),
  /** items: [{ id: int, at: ms, title, body }]. Replaces everything scheduled before. */
  async schedule(items) {
    if (!native) return 'web'
    const sig = JSON.stringify(items)
    if (sig === lastSig) return 'same'
    const L = await ln()
    let perm = await L.checkPermissions()
    if (perm.display !== 'granted' && items.length) perm = await L.requestPermissions()
    if (perm.display !== 'granted') return 'denied'
    const pending = await L.getPending()
    if (pending.notifications.length) await L.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) })
    const now = Date.now()
    const list = items.filter((i) => i.at > now + 5000).slice(0, 60)
      .map((i) => ({ id: i.id, title: i.title, body: i.body, schedule: { at: new Date(i.at), allowWhileIdle: true }, smallIcon: 'ic_stat_moneysafe', iconColor: '#0A6CF0' }))
    if (list.length) await L.schedule({ notifications: list })
    lastSig = sig
    return list.length
  },
  async tap(strength = 'light') {
    if (!native) return false
    const H = await hp()
    if (strength === 'success') await H.Haptics.notification({ type: H.NotificationType.Success })
    else await H.Haptics.impact({ style: strength === 'medium' ? H.ImpactStyle.Medium : H.ImpactStyle.Light })
    return true
  },
}
globalThis.MSNative = MSNative
export default MSNative
