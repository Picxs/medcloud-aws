const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleString('pt-BR') : '—');
const kb = (b) => (b ? `${(b / 1024).toFixed(0)} KB` : '—');
const state = { pacientes: [], medicos: [], view: 'dashboard' };

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast show ${err ? 'err' : ''}`;
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = 'toast'), 3000);
}
async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  if (r.status === 204) return null;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  if (body.cache) { const b = $('#cache-badge'); b.textContent = `Redis: ${body.cache}`; b.className = `badge ${body.cache.toLowerCase()}`; return body.data; }
  return body;
}
const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

// ---------- Navegação ----------
const titles = { dashboard: 'Painel', exames: 'Exames', pacientes: 'Pacientes', medicos: 'Médicos', auditoria: 'Auditoria' };
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
function go(view) {
  state.view = view;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $('#title').textContent = titles[view];
  render();
}
async function render() {
  try { await ({ dashboard, exames, pacientes, medicos, auditoria })[state.view](); } catch (e) { toast(e.message, true); }
}

// ---------- Cards de exame ----------
const examCard = (e) => `
  <div class="exam" data-id="${e.id}">
    <div class="img">${e.url_thumb ? `<img src="${e.url_thumb}" alt="${esc(e.tipo)}" loading="lazy">` : e.status === 'PROCESSANDO' ? '<div class="spin"></div>' : '—'}</div>
    <div class="info"><span class="pill ${e.status}">${e.status}</span><b>${esc(e.tipo)}</b>
      <small>${esc(e.paciente_nome)}</small><small>${fmtDate(e.criado_em)}</small></div>
  </div>`;
function bindCards(el, list) {
  el.innerHTML = list.length ? list.map(examCard).join('') : '<p style="color:var(--muted)">Nenhum exame.</p>';
  el.querySelectorAll('.exam').forEach((c) => c.addEventListener('click', () => openExam(c.dataset.id)));
  // Enquanto houver exame processando no worker, faz polling.
  if (list.some((e) => e.status === 'PROCESSANDO')) { clearTimeout(state.poll); state.poll = setTimeout(render, 3000); }
}

// ---------- Views ----------
async function dashboard() {
  const s = await api('/api/dashboard');
  const items = [['pacientes', 'Pacientes', 'var(--accent)'], ['medicos', 'Médicos', 'var(--accent2)'], ['exames', 'Exames', 'hsl(270 70% 65%)'],
    ['processando', 'Processando', 'var(--warn)'], ['sem_laudo', 'Aguardando laudo', 'var(--danger)']];
  $('#stats').innerHTML = items.map(([k, l, c]) => `<div class="stat" style="--c:${c}"><b>${s[k]}</b><span>${l}</span></div>`).join('');
  bindCards($('#recent'), (await api('/api/exames')).slice(0, 8));
}
async function loadRefs() {
  state.pacientes = await api('/api/pacientes'); state.medicos = await api('/api/medicos');
  $('#exame-paciente').innerHTML = state.pacientes.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('');
  $('#exame-medico').innerHTML = '<option value="">—</option>' + state.medicos.map((m) => `<option value="${m.id}">${esc(m.nome)}</option>`).join('');
}
async function exames() { await loadRefs(); bindCards($('#exames'), await api('/api/exames')); }

function table(el, rows, cols, entity) {
  el.innerHTML = `<tr>${cols.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr>` + rows.map((r) => `
    <tr>${cols.map(([k]) => `<td>${esc(k === 'nascimento' && r[k] ? r[k].slice(0, 10) : r[k])}</td>`).join('')}
      <td><button class="btn ghost sm" data-edit="${r.id}">Editar</button><button class="btn danger sm" data-del="${r.id}">Excluir</button></td></tr>`).join('');
  el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    const r = rows.find((x) => x.id == b.dataset.edit), f = $(`#form-${entity}`);
    Object.entries(r).forEach(([k, v]) => f.elements[k] && (f.elements[k].value = k === 'nascimento' && v ? v.slice(0, 10) : v ?? ''));
    $(`#${entity}-form-title`).textContent = `Editando #${r.id}`; f.scrollIntoView({ behavior: 'smooth' });
  });
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Confirmar exclusão?')) return;
    try { await api(`/api/${entity}s/${b.dataset.del}`, { method: 'DELETE' }); toast('Excluído'); render(); } catch (e) { toast(e.message, true); }
  });
}
async function pacientes() { table($('#tbl-pacientes'), await api('/api/pacientes'), [['id', '#'], ['nome', 'Nome'], ['cpf', 'CPF'], ['nascimento', 'Nascimento'], ['telefone', 'Telefone']], 'paciente'); }
async function medicos() { table($('#tbl-medicos'), await api('/api/medicos'), [['id', '#'], ['nome', 'Nome'], ['crm', 'CRM'], ['especialidade', 'Especialidade']], 'medico'); }

async function auditoria() {
  const logs = await api('/api/auditoria?limit=100');
  $('#audit').innerHTML = logs.map((l) => `<div class="log"><span>${fmtDate(l.timestamp)}</span><span class="act ${l.acao}">${l.acao}</span>
    <span>${esc(l.entidade)}</span><code>${esc(JSON.stringify(l.dados))}</code></div>`).join('') || '<p>Sem registros.</p>';
}

// ---------- Formulários ----------
['paciente', 'medico'].forEach((entity) => $(`#form-${entity}`).addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, data = Object.fromEntries(new FormData(f)), id = data.id; delete data.id;
  try {
    await api(`/api/${entity}s${id ? `/${id}` : ''}`, json(id ? 'PUT' : 'POST', data));
    toast(id ? 'Atualizado' : 'Cadastrado'); f.reset(); f.elements.id.value = '';
    $(`#${entity}-form-title`).textContent = entity === 'paciente' ? 'Novo paciente' : 'Novo médico'; render();
  } catch (e) { toast(e.message, true); }
}));

const drop = $('#drop'), file = $('#exame-arquivo');
file.addEventListener('change', () => ($('#drop-text').textContent = file.files[0]?.name || 'Selecione a imagem'));
['dragover', 'dragenter'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, () => drop.classList.remove('over')));
drop.addEventListener('drop', (ev) => { ev.preventDefault(); file.files = ev.dataTransfer.files; file.dispatchEvent(new Event('change')); });

$('#form-exame').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#btn-enviar-exame'); btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    await api('/api/exames', { method: 'POST', body: new FormData(ev.target) });
    toast('Exame enviado — processando no worker (SQS)'); ev.target.reset(); $('#drop-text').textContent = 'Arraste a imagem do exame ou clique para selecionar'; render();
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = 'Enviar para processamento';
});

// ---------- Modal do exame (laudo) ----------
async function openExam(id) {
  const e = await api(`/api/exames/${id}`);
  if (!state.medicos.length) await loadRefs();
  $('#modal-body').innerHTML = `
    <div>${e.url_preview ? `<img src="${e.url_preview}" alt="exame">` : '<div class="spin"></div>'}</div>
    <div class="meta">
      <h2>${esc(e.tipo)} <span class="pill ${e.status}">${e.status}</span></h2>
      <p><b>Paciente:</b> ${esc(e.paciente_nome)}<br><b>Médico:</b> ${esc(e.medico_nome || '—')}<br>
         <b>Enviado:</b> ${fmtDate(e.criado_em)}<br><b>Processado:</b> ${fmtDate(e.processado_em)}<br>
         <b>Original:</b> ${e.largura_original ? `${e.largura_original}×${e.altura_original}` : '—'} · ${kb(e.tamanho_original)}
         → <b>Preview:</b> ${kb(e.tamanho_preview)}</p>
      <label>Descrição<input id="m-desc" value="${esc(e.descricao)}"></label>
      <label>Laudo<textarea id="m-laudo" rows="6" placeholder="Escreva o laudo…">${esc(e.laudo)}</textarea></label>
      <div class="actions">
        <button class="btn" id="m-save" type="button">Salvar laudo</button>
        ${e.url_original ? `<a class="btn ghost" href="${e.url_original}" target="_blank">Original</a>` : ''}
        <button class="btn danger" id="m-del" type="button">Excluir</button>
        <button class="btn ghost" value="close">Fechar</button>
      </div>
    </div>`;
  $('#m-save').onclick = async () => {
    try { await api(`/api/exames/${id}`, json('PUT', { descricao: $('#m-desc').value, laudo: $('#m-laudo').value })); toast('Laudo salvo'); $('#modal').close(); render(); }
    catch (err) { toast(err.message, true); }
  };
  $('#m-del').onclick = async () => {
    if (!confirm('Excluir exame?')) return;
    await api(`/api/exames/${id}`, { method: 'DELETE' }); toast('Exame excluído'); $('#modal').close(); render();
  };
  $('#modal').showModal();
}

const showInstance = () => api('/api/health').then((h) => ($('#instance').textContent = `instância: ${h.instance}`)).catch(() => {});
showInstance(); setInterval(showInstance, 5000);
$('#btn-stress').onclick = async () => {
  try { const r = await api('/api/stress?s=180'); toast(r.alreadyRunning ? `Carga já ativa em ${r.instance}` : `CPU saturada em ${r.instance} por ${r.seconds}s`); }
  catch (e) { toast(e.message, true); }
};
render();
