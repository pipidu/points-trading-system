// ============================================================
// Server酱 消息推送服务 - 原生 fetch
// ============================================================
export async function sendServerChanNotification(
  sendKey: string,
  title: string = '待审核提醒',
  description: string = 'https://YOUR_DOMAIN/ 有待审核信息'
): Promise<boolean> {
  try {
    if (!sendKey) return false;
    const resp = await fetch(`https://sctapi.ftqq.com/${sendKey}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ title, desp: description }),
    });
    const data = await resp.json() as any;
    return data?.code === 0;
  } catch (e) { console.error('[ServerChan]', e); return false; }
}
