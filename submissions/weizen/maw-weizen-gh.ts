// maw weizen gh — GitHub Discussions wrapper (ครอบ gh ops ไว้ reuse)
// เกิดจาก workshop-05 midterm: createDiscussion / addDiscussionComment boilerplate
// (repo node-id lookup + category + GraphQL mutation) ซ้ำๆ → ครอบเป็นคำสั่งเดียว.
// รันผ่าน `gh` CLI (auth จาก gh, ไม่เก็บ token ในโค้ด) · body: @file หรือ string.
import { $ } from "bun";

type Log = (s?: string) => void;

function splitRepo(slug: string): [string, string] {
  const [owner, name] = (slug || "").split("/");
  if (!owner || !name) throw new Error(`repo ต้องเป็น owner/name — ได้ "${slug}"`);
  return [owner, name];
}
async function readBody(src: string): Promise<string> {
  if (!src) throw new Error("ต้องมี body (@file หรือ string)");
  return src.startsWith("@") ? await Bun.file(src.slice(1)).text() : src;
}
async function gq(query: string, fields: string[] = []): Promise<any> {
  // -f field=value (string) ทุกตัว — Bun $ escape ให้ปลอดภัย
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const f of fields) args.push("-f", f);
  return (await $`gh ${args}`.json());
}

export async function gh(log: Log, args: string[]): Promise<{ ok: boolean }> {
  const cmd = args[1];
  try {
    if (cmd === "disc-ls") {
      const [o, n] = splitRepo(args[2]);
      const out = await gq(`{repository(owner:"${o}",name:"${n}"){discussions(first:50,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title author{login}}}}}`);
      for (const d of out?.data?.repository?.discussions?.nodes ?? [])
        log(`#${d.number}  ${d.title}  — ${d.author?.login}`);
      return { ok: true };
    }
    if (cmd === "disc-read") {
      const [o, n] = splitRepo(args[2]);
      const out = await gq(`{repository(owner:"${o}",name:"${n}"){discussion(number:${Number(args[3])}){title author{login} body}}}`);
      const d = out?.data?.repository?.discussion;
      log(`# ${d?.title}  — ${d?.author?.login}\n`);
      log(d?.body ?? "(empty)");
      return { ok: true };
    }
    if (cmd === "disc-post") {
      // disc-post <owner/repo> <title> <@body|string> [category]
      const [o, n] = splitRepo(args[2]);
      const title = args[3], body = await readBody(args[4]), catName = args[5] || "Show and tell";
      const meta = (await gq(`{repository(owner:"${o}",name:"${n}"){id discussionCategories(first:20){nodes{id name}}}}`))?.data?.repository;
      if (!meta?.id) throw new Error(`หา repo ${o}/${n} ไม่เจอ (private/ไม่มี access?)`);
      const cat = meta.discussionCategories.nodes.find((c: any) => c.name === catName) ?? meta.discussionCategories.nodes[0];
      const out = await gq(
        `mutation($r:ID!,$c:ID!,$t:String!,$b:String!){createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){discussion{number url}}}`,
        [`r=${meta.id}`, `c=${cat.id}`, `t=${title}`, `b=${body}`]);
      const d = out?.data?.createDiscussion?.discussion;
      log(`✅ created #${d?.number}  ${d?.url}`);
      return { ok: true };
    }
    if (cmd === "disc-comment") {
      // disc-comment <owner/repo> <number> <@body|string>
      const [o, n] = splitRepo(args[2]);
      const d = (await gq(`{repository(owner:"${o}",name:"${n}"){discussion(number:${Number(args[3])}){id}}}`))?.data?.repository?.discussion;
      if (!d?.id) throw new Error(`หา discussion #${args[3]} ไม่เจอ`);
      const out = await gq(
        `mutation($d:ID!,$b:String!){addDiscussionComment(input:{discussionId:$d,body:$b}){comment{url}}}`,
        [`d=${d.id}`, `b=${await readBody(args[4])}`]);
      log(`✅ commented  ${out?.data?.addDiscussionComment?.comment?.url}`);
      return { ok: true };
    }
    log(`🍺 maw weizen gh — GitHub Discussions wrapper`);
    log(``);
    log(`  disc-ls <owner/repo>                          list discussions`);
    log(`  disc-read <owner/repo> <num>                  read a discussion body`);
    log(`  disc-post <owner/repo> <title> @body.md [cat] create discussion`);
    log(`  disc-comment <owner/repo> <num> @body.md      append a comment`);
    log(``);
    log(`  auth: gh CLI (no token in code) · body: @file หรือ string`);
    return { ok: true };
  } catch (e: any) {
    log(`❌ ${e?.message ?? e}`);
    return { ok: false };
  }
}
