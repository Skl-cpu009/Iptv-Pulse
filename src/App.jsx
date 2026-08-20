import { Fragment, useEffect, useMemo, useState } from 'react'

const TEST_ENDPOINT = 'https://speed.cloudflare.com'
const STORAGE_KEY = 'iptv-pulse-history-v1'

const format = (value, digits = 1) => value == null || Number.isNaN(value) ? '—' : Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits })
const nowLabel = (iso) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value))
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

function getSavedHistory() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

function scoreMetrics(m) {
  const parts = [
    [m.download, 32, (v) => clamp((v - 2) / 0.48)], // 50 Mbps = 100
    [m.upload, 8, (v) => clamp((v - 0.5) / 0.095)], // 10 Mbps = 100
    [m.ping, 18, (v) => clamp((160 - v) / 1.35)],
    [m.jitter, 14, (v) => clamp((55 - v) / 0.5)],
    [m.loadedLatency, 18, (v) => clamp((450 - v) / 3.3)],
    [m.loss, 10, (v) => clamp(100 - v * 30)],
  ].filter(([value]) => value != null && !Number.isNaN(value))
  if (!parts.length) return null
  const weight = parts.reduce((total, [, w]) => total + w, 0)
  return Math.round(parts.reduce((total, [value, w, fn]) => total + w * fn(value), 0) / weight)
}

function labelForScore(score) {
  if (score == null) return { label: 'Sem resultado', tone: 'neutral', detail: 'Faça um teste para gerar seu diagnóstico.' }
  if (score < 35) return { label: 'Ruim', tone: 'danger', detail: 'Há risco alto de travamentos e queda de qualidade.' }
  if (score < 55) return { label: 'Regular', tone: 'warn', detail: 'Funciona, mas pode oscilar em horários de pico.' }
  if (score < 72) return { label: 'Bom', tone: 'good', detail: 'Boa base para assistir com poucos dispositivos.' }
  if (score < 86) return { label: 'Muito bom', tone: 'great', detail: 'Estável para a maior parte dos usos de IPTV.' }
  return { label: 'Excelente', tone: 'excellent', detail: 'Conexão forte e responsiva para streaming.' }
}

function streamProfiles(m) {
  const stable = (m.ping ?? 999) <= 100 && (m.jitter ?? 999) <= 30 && (m.loss ?? 100) <= 2
  const capacity = m.download ?? 0
  return [
    { name: 'SD', required: 3, note: 'canais básicos', ok: capacity >= 3 && stable },
    { name: 'HD', required: 6, note: 'uso diário', ok: capacity >= 6 && stable },
    { name: 'Full HD', required: 12, note: 'alta nitidez', ok: capacity >= 12 && stable },
    { name: '4K', required: 25, note: 'máxima qualidade', ok: capacity >= 25 && stable },
  ]
}

function diagnose(m) {
  const notes = []
  if (m.download == null) return ['Não foi possível concluir as medições. Verifique sua conexão e tente novamente.']
  if (m.download < 12) notes.push('A velocidade de download está apertada para Full HD e para mais de uma tela ao mesmo tempo.')
  else if (m.download < 25) notes.push('A velocidade sustenta Full HD, mas 4K pode ficar no limite se outras pessoas usarem a rede.')
  if (m.loadedLatency != null && m.loadedLatency > 250) notes.push('Quando a rede é exigida, a resposta demora muito. Downloads, backups ou outros vídeos podem causar travamentos.')
  if (m.jitter != null && m.jitter > 25) notes.push('A variação de latência está alta. Isso pode aparecer como microtravadas, mesmo com boa velocidade.')
  if (m.loss != null && m.loss >= 2) notes.push('Houve falhas nas sondas de rede. Em IPTV ao vivo, isso pode virar congelamentos ou reconexões.')
  if (!notes.length) notes.push('Não apareceu um gargalo relevante para IPTV neste teste. Mantenha o aparelho perto do roteador ou prefira cabo de rede.')
  return notes.slice(0, 3)
}

async function timedFetch(url, options = {}) {
  const started = performance.now()
  const response = await fetch(url, { cache: 'no-store', ...options })
  if (!response.ok) throw new Error(`Servidor respondeu ${response.status}`)
  return { response, duration: performance.now() - started }
}

async function probePing() {
  const { duration } = await timedFetch(`${TEST_ENDPOINT}/__down?bytes=0&nonce=${crypto.randomUUID()}`)
  return duration
}

async function measurePing(onProgress) {
  const samples = []
  let failed = 0
  for (let i = 0; i < 7; i += 1) {
    try { samples.push(await probePing()) } catch { failed += 1 }
    onProgress?.(i + 1, 7)
  }
  const ping = average(samples)
  const jitter = samples.length > 1 ? average(samples.slice(1).map((value, index) => Math.abs(value - samples[index]))) : null
  return { ping, jitter, loss: (failed / 7) * 100, samples }
}

async function measureDownload(onLoadPing) {
  const bytes = 12 * 1024 * 1024
  const controller = new AbortController()
  const started = performance.now()
  let loaded = 0
  let loadPings = []
  const pingTimer = setTimeout(async () => {
    const tasks = Array.from({ length: 3 }, () => probePing().catch(() => null))
    loadPings = (await Promise.all(tasks)).filter(Boolean)
  }, 500)
  try {
    const response = await fetch(`${TEST_ENDPOINT}/__down?bytes=${bytes}&nonce=${crypto.randomUUID()}`, { cache: 'no-store', signal: controller.signal })
    if (!response.ok || !response.body) throw new Error('Download não suportado pelo navegador')
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      loaded += value.byteLength
    }
  } finally { clearTimeout(pingTimer) }
  const elapsed = performance.now() - started
  if (!loadPings.length) {
    try { loadPings = [await probePing()] } catch { /* no load latency available */ }
  }
  const loadedLatency = average(loadPings)
  onLoadPing?.(loadedLatency)
  return { download: (loaded * 8) / elapsed / 1000, loadedLatency }
}

async function measureUpload() {
  const bytes = 3 * 1024 * 1024
  const payload = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
  const { duration } = await timedFetch(`${TEST_ENDPOINT}/__up?nonce=${crypto.randomUUID()}`, { method: 'POST', body: payload })
  return (bytes * 8) / duration / 1000
}

function MetricCard({ label, value, unit, caption, estimated, emphasis }) {
  return <article className={`metric-card ${emphasis ? 'metric-emphasis' : ''}`}>
    <div className="metric-head"><span>{label}</span>{estimated && <span className="estimate">estimado</span>}</div>
    <strong>{value}</strong><small>{unit}</small>
    <p>{caption}</p>
  </article>
}

function App() {
  const [history, setHistory] = useState(getSavedHistory)
  const [provider, setProvider] = useState('')
  const [active, setActive] = useState(null)
  const [status, setStatus] = useState('idle')
  const [step, setStep] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [compareLeft, setCompareLeft] = useState('')
  const [compareRight, setCompareRight] = useState('')
  const score = active?.score ?? null
  const verdict = labelForScore(score)
  const streams = useMemo(() => active ? streamProfiles(active) : streamProfiles({}), [active])

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)) }, [history])

  async function runTest() {
    setStatus('testing'); setProgress(2); setError(''); setActive(null)
    try {
      setStep('Medindo resposta e estabilidade…')
      const basic = await measurePing((current, total) => setProgress(5 + (current / total) * 24))
      setStep('Medindo download e resposta sob carga…')
      const down = await measureDownload(() => setProgress(66))
      setProgress(69); setStep('Medindo upload…')
      let upload = null
      try { upload = await measureUpload() } catch { /* endpoint may disallow uploads in some networks */ }
      setProgress(92); setStep('Calculando adequação para IPTV…')
      const result = {
        id: crypto.randomUUID(), createdAt: new Date().toISOString(), provider: provider.trim() || 'Não informado',
        download: down.download, upload, ping: basic.ping, jitter: basic.jitter, loss: basic.loss,
        loadedLatency: down.loadedLatency, network: navigator.connection?.effectiveType || 'não informado',
      }
      result.score = scoreMetrics(result)
      setActive(result)
      setHistory(current => [result, ...current].slice(0, 20))
      setProgress(100); setStep('Teste concluído')
      setStatus('complete')
    } catch (cause) {
      setError('Não foi possível alcançar o servidor de medição. Tente novamente em alguns instantes.'); setStatus('error')
    }
  }

  function openHistory(item) { setActive(item); setStatus('complete'); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  function clearHistory() { setHistory([]); setCompareLeft(''); setCompareRight('') }
  async function share() {
    if (!active) return
    const text = `Meu diagnóstico IPTV Pulse: ${active.score}/100 (${labelForScore(active.score).label}). Download ${format(active.download)} Mbps, ping ${format(active.ping, 0)} ms e jitter ${format(active.jitter, 0)} ms.`
    try {
      if (navigator.share) await navigator.share({ title: 'Resultado IPTV Pulse', text })
      else { await navigator.clipboard.writeText(text); alert('Resultado copiado para a área de transferência.') }
    } catch { /* user cancelled share */ }
  }
  const left = history.find(item => item.id === compareLeft)
  const right = history.find(item => item.id === compareRight)
  const comparisons = [['Score', 'score', ''], ['Download', 'download', 'Mbps'], ['Upload', 'upload', 'Mbps'], ['Ping', 'ping', 'ms'], ['Jitter', 'jitter', 'ms'], ['Sob carga', 'loadedLatency', 'ms'], ['Perda*', 'loss', '%']]

  return <main>
    <div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <nav className="topbar"><a className="brand" href="#inicio"><i>▶</i> IPTV <b>Pulse</b></a><span className="nav-note">Diagnóstico para streaming ao vivo</span></nav>
    <section className="hero" id="inicio">
      <div className="eyebrow"><span /> TESTE INTELIGENTE PARA IPTV</div>
      <h1>Sua internet aguenta<br /><em>TV sem travar?</em></h1>
      <p>Medimos velocidade, estabilidade e resposta da rede para mostrar o que realmente importa na hora de assistir ao vivo.</p>
      <div className="test-control">
        <label>Operadora (opcional)<input value={provider} onChange={e => setProvider(e.target.value)} placeholder="Ex.: Vivo, Claro, Wi‑Fi Casa" disabled={status === 'testing'} /></label>
        <button className="test-button" onClick={runTest} disabled={status === 'testing'}>{status === 'testing' ? 'Testando conexão…' : 'Iniciar diagnóstico'} <span>→</span></button>
      </div>
      <div className="trust-row"><span>◉ Mede estabilidade</span><span>◉ Histórico só neste aparelho</span><span>◉ Sem cadastro</span></div>
    </section>

    {status === 'testing' && <section className="progress-panel"><div className="progress-meta"><span>{step}</span><b>{Math.round(progress)}%</b></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><p>Não feche esta aba durante o diagnóstico.</p></section>}
    {status === 'error' && <section className="alert"><b>Não conseguimos completar o teste.</b> {error}</section>}

    {active && <>
      <section className="result-banner" aria-live="polite">
        <div className="score-ring" style={{ '--score': active.score }}><div><strong>{active.score}</strong><small>/ 100</small></div></div>
        <div className="verdict"><span className={`status-pill ${verdict.tone}`}>{verdict.label}</span><h2>Diagnóstico para IPTV</h2><p>{verdict.detail}</p><small>{active.provider} · {nowLabel(active.createdAt)} · rede {active.network}</small></div>
        <button className="share-button" onClick={share}>↗ <span>Compartilhar</span></button>
      </section>
      <section className="metrics-grid">
        <MetricCard label="Download" value={format(active.download)} unit="Mbps" caption="capacidade para receber vídeo" emphasis />
        <MetricCard label="Upload" value={format(active.upload)} unit="Mbps" caption="envio e interação" />
        <MetricCard label="Ping" value={format(active.ping, 0)} unit="ms" caption="resposta da conexão" estimated />
        <MetricCard label="Jitter" value={format(active.jitter, 0)} unit="ms" caption="variação da resposta" estimated />
        <MetricCard label="Resposta sob carga" value={format(active.loadedLatency, 0)} unit="ms" caption="com download acontecendo" estimated />
        <MetricCard label="Perda de pacotes" value={format(active.loss, 1)} unit="%" caption="falhas nas sondas" estimated />
      </section>
      <section className="insight-grid">
        <article className="panel suitability"><div className="section-kicker">O QUE DÁ PARA ASSISTIR</div><h2>Adequação por qualidade</h2><div className="quality-list">{streams.map(stream => <div className="quality" key={stream.name}><div><b>{stream.name}</b><span>{stream.note}</span></div><small>mín. {stream.required} Mbps</small><i className={stream.ok ? 'yes' : 'no'}>{stream.ok ? '✓ Indicado' : '— Não recomendado'}</i></div>)}</div></article>
        <article className="panel bottleneck"><div className="section-kicker">LEITURA DO RESULTADO</div><h2>O que merece atenção</h2><div className="diagnosis">{diagnose(active).map((note, index) => <p key={note}><span>{index + 1}</span>{note}</p>)}</div><div className="tip"><b>Dica rápida</b><br />Para a melhor leitura, teste com a TV/app fechados e sem downloads em andamento. Prefira cabo de rede ao Wi‑Fi.</div></article>
      </section>
    </>}

    <section className="history-section" id="historico">
      <div className="section-heading"><div><div className="section-kicker">NO SEU APARELHO</div><h2>Histórico de diagnósticos</h2></div>{history.length > 0 && <button className="text-button" onClick={clearHistory}>Limpar histórico</button>}</div>
      {history.length === 0 ? <div className="empty"><span>◌</span><b>Ainda não há testes salvos</b><p>Seus próximos diagnósticos aparecerão aqui para você acompanhar a estabilidade da conexão.</p></div> : <div className="history-list">{history.map(item => <button className={`history-row ${active?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => openHistory(item)}><div><b>{item.provider}</b><span>{nowLabel(item.createdAt)}</span></div><strong>{item.score}<small>/100</small></strong><span className={`status-pill ${labelForScore(item.score).tone}`}>{labelForScore(item.score).label}</span><i>›</i></button>)}</div>}
    </section>

    {history.length >= 2 && <section className="compare-section"><div className="section-heading"><div><div className="section-kicker">LADO A LADO</div><h2>Comparar dois testes</h2></div></div><div className="selectors"><select value={compareLeft} onChange={e => setCompareLeft(e.target.value)}><option value="">Selecione o primeiro teste</option>{history.map(item => <option value={item.id} key={item.id}>{item.provider} · {nowLabel(item.createdAt)}</option>)}</select><span>vs</span><select value={compareRight} onChange={e => setCompareRight(e.target.value)}><option value="">Selecione o segundo teste</option>{history.map(item => <option value={item.id} key={item.id}>{item.provider} · {nowLabel(item.createdAt)}</option>)}</select></div>{left && right && <div className="comparison"><div></div><b>{left.provider}</b><b>{right.provider}</b>{comparisons.map(([label, key, unit]) => { const lowWins = ['ping', 'jitter', 'loadedLatency', 'loss'].includes(key); const l = left[key], r = right[key]; return <Fragment key={key}><span>{label}</span><strong className={(lowWins ? l < r : l > r) ? 'winner' : ''}>{format(l, key === 'score' ? 0 : 1)} <small>{unit}</small></strong><strong className={(lowWins ? r < l : r > l) ? 'winner' : ''}>{format(r, key === 'score' ? 0 : 1)} <small>{unit}</small></strong></Fragment> })}</div>}</section>}

    <section className="method"><b>Sobre as medições</b><p>Download e upload usam transferência HTTP com um servidor público. Ping, jitter e “perda de pacotes” são aproximações por requisições HTTP: o navegador não permite testar ICMP/UDP diretamente. “Resposta sob carga” mede requisições enquanto o download acontece. Os resultados variam conforme Wi‑Fi, aparelho, servidor e uso da rede.</p></section>
    <footer>IPTV Pulse · diagnóstico local e sem conta</footer>
  </main>
}

export default App
