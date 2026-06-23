import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: CORS }); }

async function hashPassword(password: string, salt?: string): Promise<string> {
  const enc = new TextEncoder();
  const saltBytes = salt ? Uint8Array.from(atob(salt), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `${btoa(String.fromCharCode(...saltBytes))}:${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}
async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  return (await hashPassword(pw, stored.split(":")[0])) === stored;
}
function newToken() { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[^a-zA-Z0-9]/g,"").slice(0,40); }

async function getMe(token: string | null) {
  if (!token) return null;
  const { data } = await admin.from("rep_sessions")
    .select("account_id, expires_at, rep_accounts(id, character_name, is_dm, honor_score)")
    .eq("token", token).maybeSingle();
  if (!data) return null;
  if (new Date((data as any).expires_at) < new Date()) return null;
  return (data as any).rep_accounts as { id: string; character_name: string; is_dm: boolean; honor_score: number };
}

async function groupPeers(npcId: string): Promise<string[]> {
  const { data: npc } = await admin.from("rep_npcs").select("rep_group_id").eq("id", npcId).maybeSingle();
  const gid = (npc as any)?.rep_group_id;
  if (!gid) return [];
  const { data: peers } = await admin.from("rep_npcs").select("id").eq("rep_group_id", gid).neq("id", npcId);
  return (peers ?? []).map((p: any) => p.id);
}

async function syncFromPrimary(groupId: string, primaryNpcId: string) {
  const { data: members } = await admin.from("rep_npcs").select("id").eq("rep_group_id", groupId).neq("id", primaryNpcId);
  if (!(members ?? []).length) return;
  const { data: primaryScores } = await admin.from("rep_scores").select("account_id, value").eq("npc_id", primaryNpcId);
  for (const member of members ?? []) {
    for (const s of primaryScores ?? []) {
      await admin.from("rep_scores").upsert(
        { account_id: (s as any).account_id, npc_id: (member as any).id, value: (s as any).value, updated_at: new Date().toISOString() },
        { onConflict: "account_id,npc_id" }
      );
    }
  }
}

async function buildGroupsList() {
  const { data: groups } = await admin.from("rep_groups").select("id, name, primary_npc_id, created_at").order("name");
  const { data: members } = await admin.from("rep_npcs").select("id, name, role, grp, rep_group_id").not("rep_group_id", "is", null);
  const membersByGroup: Record<string, any[]> = {};
  for (const m of members ?? []) {
    const gid = (m as any).rep_group_id;
    if (!membersByGroup[gid]) membersByGroup[gid] = [];
    membersByGroup[gid].push({ id: (m as any).id, name: (m as any).name, role: (m as any).role, grp: (m as any).grp });
  }
  return (groups ?? []).map((g: any) => ({ ...g, rep_npcs: membersByGroup[g.id] ?? [] }));
}

// Level -> cumulative IP table
const LEVEL_IP: Record<number, number> = {
  1:1,2:2,3:4,4:6,5:9,6:12,7:16,8:20,9:25,10:30,
  11:40,12:46,13:52,14:59,15:66,16:81,17:89,18:97,19:106,20:115,
  21:135,22:144,23:153,24:163,25:173
};

async function getPlayerInvestiture(accountId: string) {
  const [poolR, skillsR, upgradesR, setItemsR] = await Promise.all([
    admin.from("player_investiture").select("*").eq("account_id", accountId).maybeSingle(),
    admin.from("player_skills").select("*").eq("account_id", accountId).order("sort_order"),
    admin.from("player_skill_upgrades").select("*"),
    admin.from("player_set_items").select("*").eq("account_id", accountId).order("slot"),
  ]);
  const pool = (poolR.data as any) ?? { account_id: accountId, level: 1, total_points: 0, ip_log: [] };
  const skills = (skillsR.data ?? []) as any[];
  const upgrades = (upgradesR.data ?? []) as any[];
  // attach upgrades to skills
  const skillIds = new Set(skills.map((s:any)=>s.id));
  const upgMap: Record<string,any[]> = {};
  for (const u of upgrades) {
    if (!skillIds.has(u.skill_id)) continue;
    if (!upgMap[u.skill_id]) upgMap[u.skill_id] = [];
    upgMap[u.skill_id].push(u);
  }
  const skillsWithUpgrades = skills.map((s:any)=>({ ...s, upgrades: upgMap[s.id]??[] }));
  const spentInSkills = skills.reduce((a:number,s:any)=>a+s.points_invested,0);
  const spentInSetItems = (setItemsR.data??[]).reduce((a:number,si:any)=>a+si.points_invested,0);
  return {
    pool,
    skills: skillsWithUpgrades,
    set_items: setItemsR.data ?? [],
    total_points: pool.total_points,
    spent_points: spentInSkills + spentInSetItems,
    available_points: pool.total_points - spentInSkills - spentInSetItems,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let payload: any = {};
  try { payload = await req.json(); } catch { }
  const action = payload.action as string;
  const token = req.headers.get("x-session-token");

  try {
    // --- PUBLIC ---
    if (action === "list_characters") {
      const { data } = await admin.from("rep_accounts").select("character_name, is_dm").order("character_name");
      return json({ characters: data });
    }
    if (action === "wiki_get_all") {
      const { data } = await admin.from("wiki_pages").select("id,title,nav_order,show_in_nav").order("nav_order");
      return json({ pages: data });
    }
    if (action === "wiki_get_page") {
      const { data } = await admin.from("wiki_pages").select("*").eq("id", payload.id).maybeSingle();
      return json({ page: data });
    }
    if (action === "login") {
      const { character_name, password } = payload;
      const { data: acct } = await admin.from("rep_accounts").select("*").eq("character_name", character_name).maybeSingle();
      if (!acct) return json({ error: "Unknown character" }, 401);
      if (!(await verifyPassword(password, (acct as any).password_hash))) return json({ error: "Incorrect password" }, 401);
      const tk = newToken();
      await admin.from("rep_sessions").insert({ token: tk, account_id: (acct as any).id });
      return json({ token: tk, character_name: (acct as any).character_name, is_dm: (acct as any).is_dm, honor_score: (acct as any).honor_score ?? 0 });
    }
    if (action === "logout") {
      if (token) await admin.from("rep_sessions").delete().eq("token", token);
      return json({ ok: true });
    }

    const me = await getMe(token);
    if (!me) return json({ error: "Not authenticated" }, 401);

    if (action === "me") return json({ character_name: me.character_name, is_dm: me.is_dm, honor_score: me.honor_score ?? 0 });
    if (action === "change_password") {
      if ((payload.new_password || "").length < 3) return json({ error: "Too short" }, 400);
      await admin.from("rep_accounts").update({ password_hash: await hashPassword(payload.new_password) }).eq("id", me.id);
      return json({ ok: true });
    }
    if (action === "get_state") {
      const [npcsR, scoresR, notesR, groupsR] = await Promise.all([
        admin.from("rep_npcs").select("*").order("grp").order("sort_order"),
        admin.from("rep_scores").select("npc_id, value").eq("account_id", me.id),
        admin.from("rep_notes").select("npc_id, body").eq("account_id", me.id),
        admin.from("rep_groups").select("id, name, primary_npc_id").order("name"),
      ]);
      const scores: Record<string,number> = {};
      (scoresR.data ?? []).forEach((s: any) => { scores[s.npc_id] = s.value; });
      const notes: Record<string,string> = {};
      (notesR.data ?? []).forEach((n: any) => { notes[n.npc_id] = n.body; });
      return json({ npcs: npcsR.data ?? [], scores, notes, is_dm: me.is_dm, honor_score: me.honor_score ?? 0, rep_groups: groupsR.data ?? [] });
    }
    if (action === "poll_scores") {
      const { data } = await admin.from("rep_scores").select("npc_id, value").eq("account_id", me.id);
      const scores: Record<string,number> = {};
      (data ?? []).forEach((s: any) => { scores[s.npc_id] = s.value; });
      return json({ scores, ts: Date.now() });
    }
    if (action === "set_note") {
      await admin.from("rep_notes").upsert({ account_id: me.id, npc_id: payload.npc_id, body: payload.body??"", updated_at: new Date().toISOString() }, { onConflict: "account_id,npc_id" });
      return json({ ok: true });
    }

    // --- INVESTITURE (player) ---
    if (action === "get_investiture_state") {
      const data = await getPlayerInvestiture(me.id);
      return json(data);
    }
    if (action === "invest_skill") {
      // player invests points into a skill
      const { skill_id, amount } = payload;
      const pts = parseInt(amount);
      if (isNaN(pts) || pts < 1) return json({ error: "Invalid amount" }, 400);
      const { data: skill } = await admin.from("player_skills").select("*").eq("id", skill_id).eq("account_id", me.id).maybeSingle();
      if (!skill) return json({ error: "Skill not found" }, 404);
      // get available points
      const state = await getPlayerInvestiture(me.id);
      if (state.available_points < pts) return json({ error: "Not enough Investiture Points" }, 400);
      // calc max investable for allomancy/passive
      if (skill.skill_type === "allomancy" || skill.skill_type === "passive") {
        const maxPts = skill.is_mastered ? 9 : 10;
        if (skill.points_invested + pts > maxPts) return json({ error: `Max ${maxPts} pts for this skill` }, 400);
      }
      if (skill.skill_type === "signet") {
        // signets: no hard cap here — upgrades handle their own sub-pools
        if (skill.points_invested + pts > 999) return json({ error: "Amount too large" }, 400);
      }
      if (skill.skill_type === "custom") {
        // check against custom item max
        const { data: ci } = await admin.from("custom_investable_items").select("*").eq("id", skill.custom_item_id).maybeSingle();
        if (ci) {
          const maxCustom = (ci.tier1_cost??1)+(ci.tier2_cost??2)+(ci.tier3_cost??3)+(ci.tier4_cost??4);
          if (skill.points_invested + pts > maxCustom) return json({ error: `Max ${maxCustom} pts for this custom item` }, 400);
        }
      }
      await admin.from("player_skills").update({ points_invested: skill.points_invested + pts }).eq("id", skill_id);
      return json({ ok: true, new_total: skill.points_invested + pts });
    }
    if (action === "invest_upgrade") {
      // invest in a signet sub-upgrade
      const { skill_id, upgrade_key, upgrade_name, amount } = payload;
      const pts = parseInt(amount);
      if (isNaN(pts) || pts < 1) return json({ error: "Invalid amount" }, 400);
      const { data: skill } = await admin.from("player_skills").select("*").eq("id", skill_id).eq("account_id", me.id).maybeSingle();
      if (!skill) return json({ error: "Skill not found" }, 404);
      const state = await getPlayerInvestiture(me.id);
      if (state.available_points < pts) return json({ error: "Not enough Investiture Points" }, 400);
      // upsert the upgrade row
      const { data: existing } = await admin.from("player_skill_upgrades").select("*").eq("skill_id", skill_id).eq("upgrade_key", upgrade_key).maybeSingle();
      if (existing) {
        await admin.from("player_skill_upgrades").update({ points_invested: existing.points_invested + pts }).eq("id", existing.id);
      } else {
        await admin.from("player_skill_upgrades").insert({ skill_id, upgrade_key, upgrade_name: upgrade_name || upgrade_key, points_invested: pts });
      }
      // also add to skill's total
      await admin.from("player_skills").update({ points_invested: skill.points_invested + pts }).eq("id", skill_id);
      return json({ ok: true });
    }
    if (action === "invest_set_item") {
      const { set_item_id, amount } = payload;
      const pts = parseInt(amount);
      if (isNaN(pts) || pts < 1) return json({ error: "Invalid amount" }, 400);
      const { data: si } = await admin.from("player_set_items").select("*").eq("id", set_item_id).eq("account_id", me.id).maybeSingle();
      if (!si) return json({ error: "Set item not found" }, 404);
      if (!si.is_unlocked) return json({ error: "Set item not yet granted by DM" }, 403);
      // max for set items: 3+6+12+24 = 45
      if (si.points_invested + pts > 45) return json({ error: "Max 45 pts for set items" }, 400);
      const state = await getPlayerInvestiture(me.id);
      if (state.available_points < pts) return json({ error: "Not enough Investiture Points" }, 400);
      await admin.from("player_set_items").update({ points_invested: si.points_invested + pts }).eq("id", set_item_id);
      return json({ ok: true, new_total: si.points_invested + pts });
    }

    // --- INBOX (player) ---
    if (action === "get_inbox") {
      const { data } = await admin.from("player_inbox")
        .select("*")
        .or(`to_account_id.eq.${me.id},to_account_id.is.null`)
        .order("created_at", { ascending: false });
      return json({ messages: data ?? [] });
    }
    if (action === "mark_message_read") {
      await admin.from("player_inbox").update({ is_read: true }).eq("id", payload.message_id).or(`to_account_id.eq.${me.id},to_account_id.is.null`);
      return json({ ok: true });
    }

    // --- DM ONLY BELOW ---
    if (action === "preview_as_player") {
      if (!me.is_dm) return json({ error: "DM only" }, 403);
      const { data: tAcct } = await admin.from("rep_accounts").select("id,character_name,honor_score").eq("id", payload.target_account_id).maybeSingle();
      if (!tAcct) return json({ error: "Not found" }, 404);
      const [npcsR, scoresR, notesR, groupsR] = await Promise.all([
        admin.from("rep_npcs").select("*").order("grp").order("sort_order"),
        admin.from("rep_scores").select("npc_id,value").eq("account_id", (tAcct as any).id),
        admin.from("rep_notes").select("npc_id,body").eq("account_id", (tAcct as any).id),
        admin.from("rep_groups").select("id,name,primary_npc_id").order("name"),
      ]);
      const scores: Record<string,number> = {};
      (scoresR.data ?? []).forEach((s: any) => { scores[s.npc_id] = s.value; });
      const notes: Record<string,string> = {};
      (notesR.data ?? []).forEach((n: any) => { notes[n.npc_id] = n.body; });
      return json({ npcs: npcsR.data??[], scores, notes, is_dm: false, honor_score: (tAcct as any).honor_score??0, previewing_as: (tAcct as any).character_name, rep_groups: groupsR.data??[] });
    }

    if (!me.is_dm) return json({ error: "DM only" }, 403);

    // --- NPC / REPUTATION ---
    if (action === "set_score") {
      let { target_account_id, npc_id, value } = payload;
      value = Math.max(-20, Math.min(20, parseInt(value)));
      const now = new Date().toISOString();
      const allIds = [npc_id, ...await groupPeers(npc_id)];
      for (const id of allIds) {
        await admin.from("rep_scores").upsert({ account_id: target_account_id, npc_id: id, value, updated_at: now }, { onConflict: "account_id,npc_id" });
      }
      return json({ ok: true });
    }
    if (action === "set_score_all") {
      let { npc_id, value } = payload;
      value = Math.max(-20, Math.min(20, parseInt(value)));
      const { data: players } = await admin.from("rep_accounts").select("id").eq("is_dm", false);
      const playerIds = (players??[]).map((p:any)=>p.id);
      const now = new Date().toISOString();
      const allIds = [npc_id, ...await groupPeers(npc_id)];
      for (const id of allIds) {
        const rows = playerIds.map(pid => ({ account_id: pid, npc_id: id, value, updated_at: now }));
        if (rows.length) await admin.from("rep_scores").upsert(rows, { onConflict: "account_id,npc_id" });
      }
      return json({ ok: true });
    }
    if (action === "list_players") {
      const { data } = await admin.from("rep_accounts").select("id,character_name,is_dm,honor_score").order("character_name");
      return json({ players: data });
    }
    if (action === "dm_scores_for_npc") {
      const { data: players } = await admin.from("rep_accounts").select("id,character_name,honor_score").eq("is_dm",false).order("character_name");
      const { data: scores } = await admin.from("rep_scores").select("account_id,value").eq("npc_id", payload.npc_id);
      const sMap: Record<string,number> = {};
      (scores??[]).forEach((s:any)=>{ sMap[s.account_id]=s.value; });
      return json({ players, scores: sMap });
    }
    if (action === "upsert_npc") {
      const n = payload.npc;
      if (n.id) { const { id, ...rest } = n; await admin.from("rep_npcs").update(rest).eq("id", id); return json({ ok: true, id }); }
      if (n.sort_order == null) {
        let q = admin.from("rep_npcs").select("sort_order").order("sort_order",{ascending:false}).limit(1);
        q = n.grp==null ? q.is("grp",null) : q.eq("grp",n.grp);
        q = n.subgroup==null ? q.is("subgroup",null) : q.eq("subgroup",n.subgroup);
        const { data: last } = await q.maybeSingle();
        n.sort_order = (last as any)?.sort_order != null ? (last as any).sort_order+1 : 1000;
      }
      const { data } = await admin.from("rep_npcs").insert(n).select("id").single();
      return json({ ok: true, id: (data as any)?.id });
    }
    if (action === "delete_npc") { await admin.from("rep_npcs").delete().eq("id", payload.npc_id); return json({ ok: true }); }
    if (action === "set_portrait") { await admin.from("rep_npcs").update({ portrait_path: payload.portrait_path }).eq("id", payload.npc_id); return json({ ok: true }); }
    if (action === "upload_portrait") {
      const { npc_id, filename, data_base64, content_type } = payload;
      const bytes = Uint8Array.from(atob(data_base64), c => c.charCodeAt(0));
      const up = await admin.storage.from("portraits").upload(filename, bytes, { contentType: content_type||"image/jpeg", upsert: true });
      if (up.error) return json({ error: up.error.message }, 400);
      const portrait_path = "portraits/"+filename;
      if (npc_id) await admin.from("rep_npcs").update({ portrait_path }).eq("id", npc_id);
      return json({ ok: true, portrait_path });
    }
    if (action === "copy_portrait") {
      const { data: src } = await admin.from("rep_npcs").select("portrait_path").eq("id", payload.source_npc_id).maybeSingle();
      if (!(src as any)?.portrait_path) return json({ error: "Source has no portrait" }, 400);
      await admin.from("rep_npcs").update({ portrait_path: (src as any).portrait_path }).eq("id", payload.target_npc_id);
      return json({ ok: true, portrait_path: (src as any).portrait_path });
    }
    if (action === "all_notes") {
      const { data: notes } = await admin.from("rep_notes").select("account_id,npc_id,body,updated_at").neq("body","");
      const { data: accts } = await admin.from("rep_accounts").select("id,character_name,is_dm");
      return json({ notes: notes??[], accounts: accts??[] });
    }
    if (action === "reorder_npcs") {
      for (const it of payload.items??[]) await admin.from("rep_npcs").update({ sort_order: it.sort_order }).eq("id", it.id);
      return json({ ok: true });
    }
    if (action === "rename_label") {
      if (!["grp","subgroup","section"].includes(payload.field)) return json({ error: "Invalid field" }, 400);
      await admin.from("rep_npcs").update({ [payload.field]: payload.new_value }).eq(payload.field, payload.old_value);
      return json({ ok: true });
    }
    if (action === "set_honor") {
      const h = Math.max(0, Math.min(100, parseInt(payload.honor_score)));
      await admin.from("rep_accounts").update({ honor_score: h }).eq("id", payload.target_account_id);
      return json({ ok: true, honor_score: h });
    }
    if (action === "create_account") {
      const { character_name, password, is_dm } = payload;
      if (!character_name||!password) return json({ error: "Name and password required" }, 400);
      const { data, error } = await admin.from("rep_accounts").insert({ character_name, password_hash: await hashPassword(password), is_dm:!!is_dm, honor_score:0 }).select("id").single();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, id: (data as any)?.id });
    }
    if (action === "update_account") {
      const { target_account_id, character_name, password, is_dm, honor_score } = payload;
      const upd: any = {};
      if (character_name!==undefined) upd.character_name=character_name;
      if (is_dm!==undefined) upd.is_dm=is_dm;
      if (honor_score!==undefined) upd.honor_score=Math.max(0,Math.min(100,parseInt(honor_score)));
      if (password) upd.password_hash=await hashPassword(password);
      await admin.from("rep_accounts").update(upd).eq("id", target_account_id);
      return json({ ok: true });
    }
    if (action === "delete_account") {
      const { target_account_id } = payload;
      await admin.from("rep_sessions").delete().eq("account_id", target_account_id);
      await admin.from("rep_scores").delete().eq("account_id", target_account_id);
      await admin.from("rep_notes").delete().eq("account_id", target_account_id);
      await admin.from("player_investiture").delete().eq("account_id", target_account_id);
      await admin.from("player_skills").delete().eq("account_id", target_account_id);
      await admin.from("player_set_items").delete().eq("account_id", target_account_id);
      await admin.from("player_inbox").delete().eq("to_account_id", target_account_id);
      await admin.from("rep_accounts").delete().eq("id", target_account_id);
      return json({ ok: true });
    }
    if (action === "list_accounts") {
      const { data } = await admin.from("rep_accounts").select("id,character_name,is_dm,honor_score,created_at").order("character_name");
      return json({ accounts: data??[] });
    }
    if (action === "stats_data") {
      const [npcs, accounts, scores, notes] = await Promise.all([
        admin.from("rep_npcs").select("id,name,role,grp,subgroup,wing,section,squad,year,signet,second_signet,status,deceased,portrait_path,rep_group_id"),
        admin.from("rep_accounts").select("id,character_name,is_dm,honor_score"),
        admin.from("rep_scores").select("account_id,npc_id,value,updated_at"),
        admin.from("rep_notes").select("account_id,npc_id,body,updated_at"),
      ]);
      return json({ npcs:npcs.data??[], accounts:accounts.data??[], scores:scores.data??[], notes:notes.data??[] });
    }
    if (action === "export_all") {
      const [npcs, accounts, scores, notes] = await Promise.all([
        admin.from("rep_npcs").select("*").order("sort_order"),
        admin.from("rep_accounts").select("id,character_name,is_dm,honor_score,created_at"),
        admin.from("rep_scores").select("*"),
        admin.from("rep_notes").select("*"),
      ]);
      return json({ exported_at: new Date().toISOString(), npcs:npcs.data??[], accounts:accounts.data??[], scores:scores.data??[], notes:notes.data??[] });
    }

    // REP GROUPS
    if (action === "list_rep_groups") { return json({ groups: await buildGroupsList() }); }
    if (action === "create_rep_group") {
      const { data, error } = await admin.from("rep_groups").insert({ name: payload.name }).select("id").single();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, id: (data as any).id });
    }
    if (action === "delete_rep_group") {
      await admin.from("rep_npcs").update({ rep_group_id: null }).eq("rep_group_id", payload.group_id);
      await admin.from("rep_groups").delete().eq("id", payload.group_id);
      return json({ ok: true });
    }
    if (action === "rename_rep_group") {
      await admin.from("rep_groups").update({ name: payload.name }).eq("id", payload.group_id);
      return json({ ok: true });
    }
    if (action === "set_npc_rep_group") {
      const { npc_id, group_id } = payload;
      await admin.from("rep_npcs").update({ rep_group_id: group_id||null }).eq("id", npc_id);
      if (group_id) {
        const { data: grp } = await admin.from("rep_groups").select("primary_npc_id").eq("id", group_id).maybeSingle();
        const primaryId = (grp as any)?.primary_npc_id;
        if (primaryId && primaryId !== npc_id) {
          const { data: ps } = await admin.from("rep_scores").select("account_id,value").eq("npc_id", primaryId);
          for (const s of ps??[]) {
            await admin.from("rep_scores").upsert(
              { account_id:(s as any).account_id, npc_id, value:(s as any).value, updated_at:new Date().toISOString() },
              { onConflict:"account_id,npc_id" }
            );
          }
        } else if (!primaryId) {
          await admin.from("rep_groups").update({ primary_npc_id: npc_id }).eq("id", group_id);
        }
      }
      return json({ ok: true });
    }
    if (action === "set_group_primary") {
      const { group_id, primary_npc_id } = payload;
      await admin.from("rep_groups").update({ primary_npc_id }).eq("id", group_id);
      await syncFromPrimary(group_id, primary_npc_id);
      return json({ ok: true });
    }

    // WIKI
    if (action === "wiki_save_page") {
      const { id, title, content, nav_order, show_in_nav } = payload;
      const { error } = await admin.from("wiki_pages").upsert({ id, title, content, nav_order:nav_order??99, show_in_nav:show_in_nav??true, updated_at:new Date().toISOString() }, { onConflict:"id" });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "wiki_delete_page") { await admin.from("wiki_pages").delete().eq("id", payload.id); return json({ ok: true }); }
    if (action === "wiki_upload_image") {
      const { filename, data_base64, content_type } = payload;
      const bytes = Uint8Array.from(atob(data_base64), c => c.charCodeAt(0));
      const up = await admin.storage.from("portraits").upload(`wiki/${filename}`, bytes, { contentType:content_type||"image/jpeg", upsert:true });
      if (up.error) return json({ error: up.error.message }, 400);
      return json({ ok: true, path: `wiki/${filename}` });
    }

    // --- DM: INVESTITURE MANAGEMENT ---
    if (action === "dm_get_player_investiture") {
      const data = await getPlayerInvestiture(payload.target_account_id);
      return json(data);
    }
    if (action === "list_players_investiture") {
      const { data: players } = await admin.from("rep_accounts").select("id,character_name,honor_score").eq("is_dm",false).order("character_name");
      const result = [];
      for (const p of players??[]) {
        const pool = await admin.from("player_investiture").select("level,total_points,ip_log").eq("account_id",(p as any).id).maybeSingle();
        const skills = await admin.from("player_skills").select("points_invested").eq("account_id",(p as any).id);
        const setItems = await admin.from("player_set_items").select("points_invested").eq("account_id",(p as any).id);
        const total = (pool.data as any)?.total_points ?? 0;
        const spent = [...(skills.data??[]),...(setItems.data??[])].reduce((a:number,x:any)=>a+x.points_invested,0);
        result.push({
          id:(p as any).id, character_name:(p as any).character_name,
          level:(pool.data as any)?.level??1,
          total_points:total, spent_points:spent, available_points:total-spent,
        });
      }
      return json({ players: result });
    }
    if (action === "dm_set_level") {
      const { target_account_id, level, grant_ip } = payload;
      const lvl = Math.max(1, Math.min(25, parseInt(level)));
      const { data: existing } = await admin.from("player_investiture").select("*").eq("account_id", target_account_id).maybeSingle();
      if (existing) {
        const upd: any = { level: lvl, updated_at: new Date().toISOString() };
        if (grant_ip) {
          const oldLvl = (existing as any).level ?? 1;
          const oldIp = LEVEL_IP[oldLvl] ?? 0;
          const newIp = LEVEL_IP[lvl] ?? 0;
          const delta = Math.max(0, newIp - oldIp);
          if (delta > 0) {
            const log = [...((existing as any).ip_log??[]), { amount: delta, note: `Level ${oldLvl}→${lvl}`, created_at: new Date().toISOString() }];
            upd.total_points = (existing as any).total_points + delta;
            upd.ip_log = log;
          }
        }
        await admin.from("player_investiture").update(upd).eq("account_id", target_account_id);
      } else {
        const ip = grant_ip ? (LEVEL_IP[lvl]??0) : 0;
        const log = ip > 0 ? [{ amount: ip, note: `Level set to ${lvl}`, created_at: new Date().toISOString() }] : [];
        await admin.from("player_investiture").insert({ account_id: target_account_id, level: lvl, total_points: ip, ip_log: log });
      }
      return json({ ok: true });
    }
    if (action === "dm_add_ip") {
      const { target_account_id, amount, note } = payload;
      const pts = parseInt(amount);
      if (isNaN(pts)) return json({ error: "Invalid amount" }, 400);
      const { data: existing } = await admin.from("player_investiture").select("*").eq("account_id", target_account_id).maybeSingle();
      if (existing) {
        const newTotal = Math.max(0, (existing as any).total_points + pts);
        const log = [...((existing as any).ip_log??[]), { amount: pts, note: note||"DM adjustment", created_at: new Date().toISOString() }];
        await admin.from("player_investiture").update({ total_points: newTotal, ip_log: log, updated_at: new Date().toISOString() }).eq("account_id", target_account_id);
      } else {
        const newTotal = Math.max(0, pts);
        await admin.from("player_investiture").insert({ account_id: target_account_id, level: 1, total_points: newTotal, ip_log: [{ amount: pts, note: note||"DM adjustment", created_at: new Date().toISOString() }] });
      }
      return json({ ok: true });
    }
    if (action === "dm_grant_skill") {
      const { target_account_id, skill_type, skill_key, skill_name } = payload;
      const { error } = await admin.from("player_skills").upsert(
        { account_id: target_account_id, skill_type, skill_key, skill_name, points_invested: 0, is_mastered: false },
        { onConflict: "account_id,skill_type,skill_key" }
      );
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "dm_grant_custom_skill") {
      const { target_account_id, custom_item_id } = payload;
      const { data: ci } = await admin.from("custom_investable_items").select("*").eq("id", custom_item_id).maybeSingle();
      if (!ci) return json({ error: "Custom item not found" }, 404);
      const { error } = await admin.from("player_skills").upsert(
        { account_id: target_account_id, skill_type: "custom", skill_key: `custom_${custom_item_id}`, skill_name: (ci as any).name, custom_item_id, points_invested: 0, is_mastered: false },
        { onConflict: "account_id,skill_type,skill_key" }
      );
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "dm_revoke_skill") {
      const { skill_id } = payload;
      // refund points first
      const { data: skill } = await admin.from("player_skills").select("*").eq("id", skill_id).maybeSingle();
      if (skill && (skill as any).points_invested > 0) {
        const pts = (skill as any).points_invested;
        const { data: pool } = await admin.from("player_investiture").select("*").eq("account_id", (skill as any).account_id).maybeSingle();
        if (pool) {
          const log = [...((pool as any).ip_log??[]), { amount: pts, note: `Refunded from ${(skill as any).skill_name} (revoked)`, created_at: new Date().toISOString() }];
          await admin.from("player_investiture").update({ total_points: (pool as any).total_points, ip_log: log, updated_at: new Date().toISOString() }).eq("account_id", (skill as any).account_id);
        }
      }
      await admin.from("player_skill_upgrades").delete().eq("skill_id", skill_id);
      await admin.from("player_skills").delete().eq("id", skill_id);
      return json({ ok: true });
    }
    if (action === "dm_toggle_mastered") {
      const { skill_id } = payload;
      const { data: skill } = await admin.from("player_skills").select("is_mastered").eq("id", skill_id).maybeSingle();
      if (!skill) return json({ error: "Not found" }, 404);
      await admin.from("player_skills").update({ is_mastered: !(skill as any).is_mastered }).eq("id", skill_id);
      return json({ ok: true });
    }
    if (action === "dm_refund_skill") {
      const { skill_id } = payload;
      const { data: skill } = await admin.from("player_skills").select("*").eq("id", skill_id).maybeSingle();
      if (!skill) return json({ error: "Not found" }, 404);
      const pts = (skill as any).points_invested;
      if (pts > 0) {
        const { data: pool } = await admin.from("player_investiture").select("*").eq("account_id", (skill as any).account_id).maybeSingle();
        if (pool) {
          const log = [...((pool as any).ip_log??[]), { amount: pts, note: `Refunded from ${(skill as any).skill_name}`, created_at: new Date().toISOString() }];
          await admin.from("player_investiture").update({ total_points: (pool as any).total_points, ip_log: log, updated_at: new Date().toISOString() }).eq("account_id", (skill as any).account_id);
        }
        await admin.from("player_skill_upgrades").update({ points_invested: 0 }).eq("skill_id", skill_id);
        await admin.from("player_skills").update({ points_invested: 0 }).eq("id", skill_id);
      }
      return json({ ok: true });
    }
    if (action === "dm_invest_skill_for_player") {
      // DM can invest on behalf of a player
      const { target_account_id, skill_id, amount } = payload;
      const pts = parseInt(amount);
      const { data: skill } = await admin.from("player_skills").select("*").eq("id", skill_id).eq("account_id", target_account_id).maybeSingle();
      if (!skill) return json({ error: "Skill not found" }, 404);
      const state = await getPlayerInvestiture(target_account_id);
      if (state.available_points < pts) return json({ error: "Not enough Investiture Points" }, 400);
      await admin.from("player_skills").update({ points_invested: (skill as any).points_invested + pts }).eq("id", skill_id);
      return json({ ok: true });
    }

    // SET ITEMS
    if (action === "dm_set_set_item") {
      const { target_account_id, slot, item_name, is_unlocked } = payload;
      const slotNum = parseInt(slot);
      if (is_unlocked === false) {
        // revoke: refund points and delete
        const { data: si } = await admin.from("player_set_items").select("*").eq("account_id", target_account_id).eq("slot", slotNum).maybeSingle();
        if (si && (si as any).points_invested > 0) {
          const pts = (si as any).points_invested;
          const { data: pool } = await admin.from("player_investiture").select("*").eq("account_id", target_account_id).maybeSingle();
          if (pool) {
            const log = [...((pool as any).ip_log??[]), { amount: pts, note: `Refunded from Set Item Slot ${slotNum}`, created_at: new Date().toISOString() }];
            await admin.from("player_investiture").update({ total_points: (pool as any).total_points, ip_log: log, updated_at: new Date().toISOString() }).eq("account_id", target_account_id);
          }
        }
        await admin.from("player_set_items").delete().eq("account_id", target_account_id).eq("slot", slotNum);
      } else {
        await admin.from("player_set_items").upsert(
          { account_id: target_account_id, slot: slotNum, item_name: item_name||`Set Item ${slotNum}`, is_unlocked: true, points_invested: 0 },
          { onConflict: "account_id,slot" }
        );
      }
      return json({ ok: true });
    }
    if (action === "dm_rename_set_item") {
      const { target_account_id, slot, item_name } = payload;
      await admin.from("player_set_items").update({ item_name }).eq("account_id", target_account_id).eq("slot", parseInt(slot));
      return json({ ok: true });
    }
    if (action === "dm_refund_set_item") {
      const { set_item_id } = payload;
      const { data: si } = await admin.from("player_set_items").select("*").eq("id", set_item_id).maybeSingle();
      if (!si) return json({ error: "Not found" }, 404);
      const pts = (si as any).points_invested;
      if (pts > 0) {
        const { data: pool } = await admin.from("player_investiture").select("*").eq("account_id", (si as any).account_id).maybeSingle();
        if (pool) {
          const log = [...((pool as any).ip_log??[]), { amount: pts, note: `Refunded from ${(si as any).item_name}`, created_at: new Date().toISOString() }];
          await admin.from("player_investiture").update({ total_points: (pool as any).total_points, ip_log: log, updated_at: new Date().toISOString() }).eq("account_id", (si as any).account_id);
        }
        await admin.from("player_set_items").update({ points_invested: 0 }).eq("id", set_item_id);
      }
      return json({ ok: true });
    }

    // INBOX
    if (action === "dm_send_message") {
      const { to_account_id, subject, body } = payload;
      await admin.from("player_inbox").insert({ to_account_id: to_account_id||null, subject: subject||"", body: body||"", is_read: false });
      return json({ ok: true });
    }
    if (action === "dm_get_all_inbox") {
      const [sent, accts] = await Promise.all([
        admin.from("player_inbox").select("*").order("created_at", { ascending: false }),
        admin.from("rep_accounts").select("id,character_name"),
      ]);
      return json({ messages: sent.data??[], accounts: accts.data??[] });
    }
    if (action === "dm_delete_message") {
      await admin.from("player_inbox").delete().eq("id", payload.message_id);
      return json({ ok: true });
    }

    // CUSTOM ITEMS
    if (action === "create_custom_skill") {
      const { name, description, tier1_cost, tier2_cost, tier3_cost, tier4_cost, tier1_desc, tier2_desc, tier3_desc, tier4_desc, max_tiers } = payload;
      const { data, error } = await admin.from("custom_investable_items").insert({
        name, description: description||"",
        tier1_cost: tier1_cost??1, tier2_cost: tier2_cost??2, tier3_cost: tier3_cost??3, tier4_cost: tier4_cost??4,
        tier1_desc: tier1_desc||"", tier2_desc: tier2_desc||"", tier3_desc: tier3_desc||"", tier4_desc: tier4_desc||"",
        max_tiers: max_tiers??4,
      }).select("id").single();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, id: (data as any).id });
    }
    if (action === "update_custom_skill") {
      const { id, ...rest } = payload;
      await admin.from("custom_investable_items").update(rest).eq("id", id);
      return json({ ok: true });
    }
    if (action === "delete_custom_skill") {
      await admin.from("custom_investable_items").delete().eq("id", payload.id);
      return json({ ok: true });
    }
    if (action === "list_custom_skills") {
      const { data } = await admin.from("custom_investable_items").select("*").order("name");
      return json({ items: data??[] });
    }

    return json({ error: "Unknown action: "+action }, 400);
  } catch(e) {
    return json({ error: String(e) }, 500);
  }
});
