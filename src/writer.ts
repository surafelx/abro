// AI writing: posts for other platforms, portfolio entries, and the resume.
import { askJson } from "./ai";
import { FeedItem } from "./feed";
import { Member } from "./store";
import { PostIdea, Profile, ProfileCheck, Resume, Work, linksOf } from "./work";

const STYLE = "Write plainly, the way a working developer talks. Specific over clever. No hype words (revolutionary, game-changer, unlock, delve, leverage), no emoji walls, no hashtag spam (at most 3 hashtags, only on LinkedIn and X).";

export const PLATFORMS = { linkedin: "LinkedIn", x: "X", devto: "dev.to" } as const;
export type Platform = keyof typeof PLATFORMS;

/** Drafts for each platform about a work item or a feed item. */
export async function draftPosts(m: Member, source: { work?: Work; item?: FeedItem }, platforms: Platform[]) {
  const about = source.work
    ? { type: "something I built or did", title: source.work.title, status: source.work.status, summary: source.work.summary, details: source.work.details.slice(0, 1500), stack: source.work.stack, links: linksOf(source.work) }
    : { type: "something I learned or tried", title: source.item!.title, url: source.item!.url, why: source.item!.body, source: source.item!.source };
  const { data } = await askJson<{ posts: { platform: string; body: string }[] }>({
    system: `You ghost-write posts for a developer who is job hunting and building in public. ${STYLE} Answer with JSON only.`,
    prompt: `Author: ${m.name}. Focus: ${m.focus || "software developer"}.\nAbout: ${JSON.stringify(about)}\n\n` +
      `Write one post per platform: ${platforms.map(p => PLATFORMS[p]).join(", ")}.\n` +
      `- LinkedIn: 120–220 words. Open with the concrete thing, then what was hard or surprising, then one takeaway. End with a light question.\n` +
      `- X: a thread of 3–5 tweets, each under 270 characters, separated by a blank line and numbered 1/, 2/…\n` +
      `- dev.to: a short article outline: a title line starting "# ", a 2-sentence intro, then 4–6 "## " section headings with one line each on what goes there.\n` +
      `Only claim what the facts above support. Use the platform keys ${platforms.map(p => `"${p}"`).join(", ")}. Return {"posts":[{"platform":"…","body":"…"}]}.`,
  });
  return (data.posts ?? []).filter(p => p.platform in PLATFORMS && p.body);
}

/**
 * Build-in-public post ideas from the person's own week: what they planned, finished, got stuck on
 * and built. Each idea says which part of their week it came from.
 */
export async function postIdeas(m: Member, week: { plans: string[]; done: string[]; blockers: string[]; works: { title: string; status: string; summary: string }[]; recentPosts: string[] }): Promise<PostIdea[]> {
  const { data } = await askJson<{ ideas: PostIdea[] }>({
    system: `You help a developer market themselves while job hunting by building in public. ${STYLE} Ideas must come from their real week, never generic ("5 tips for…"). Answer with JSON only.`,
    prompt: `Person: ${m.name}. Focus: ${m.focus || "software developer"}.\nTheir week:\n${JSON.stringify(week)}\n\n` +
      `Give 5 post ideas. Mix: a lesson from something hard, a small win with a concrete detail, a behind-the-scenes look at how they work, an opinion grounded in what they did, and a question to their network.\n` +
      `For each: "hook" (the opening line, under 140 characters, specific and a little surprising), "angle" (one sentence on what the post covers), "platform" ("x" or "linkedin", whichever fits better), "from" (which part of their week it comes from, in a few words).\n` +
      `Avoid repeating these recent posts: ${JSON.stringify(week.recentPosts)}. Return {"ideas":[...]}.`,
    temperature: 0.85,
  });
  return (data.ideas ?? []).filter(i => i.hook).slice(0, 5).map(i => ({ hook: String(i.hook).slice(0, 200), angle: String(i.angle ?? "").slice(0, 300), platform: i.platform === "linkedin" ? "linkedin" : "x", from: String(i.from ?? "").slice(0, 120) }));
}

/** Write a post from one idea, for one platform. */
export async function draftFromIdea(m: Member, idea: PostIdea, platform: Platform) {
  const { data } = await askJson<{ body: string }>({
    system: `You ghost-write posts for a developer building in public. ${STYLE} Answer with JSON only.`,
    prompt: `Author: ${m.name}. Focus: ${m.focus || "software developer"}.\nIdea: ${JSON.stringify(idea)}\n\n` +
      (platform === "x" ? "Write it for X: a single post under 270 characters, or a thread of 3–5 numbered tweets (1/, 2/…) separated by blank lines if it needs more room. Start with the hook." :
       platform === "linkedin" ? "Write it for LinkedIn: 120–220 words, open with the hook, short paragraphs, end with a light question." :
       "Write a dev.to outline: a '# ' title, a 2-sentence intro, then 4–6 '## ' headings with a line each.") +
      ` Return {"body":"…"}.`,
  });
  return String(data.body ?? "").trim();
}

/** Rewrite their X bio and LinkedIn headline/About from their focus and real work. */
export async function checkProfile(m: Member, profile: Profile, works: Work[]): Promise<ProfileCheck> {
  const { data } = await askJson<Omit<ProfileCheck, "at">>({
    system: `You help developers present themselves to recruiters and peers online. ${STYLE} Use only facts from the input. Answer with JSON only.`,
    prompt: `Focus / target: ${m.focus || "software developer"}\nProfile: ${JSON.stringify({ headline: profile.headline, summary: profile.summary, experience: profile.experience.slice(0, 4), skills: profile.skills })}\n` +
      `Work: ${JSON.stringify(works.slice(0, 8).map(w => ({ title: w.title, summary: w.summary, stack: w.stack, status: w.status })))}\n\n` +
      `Return {"xBio": under 160 characters, says what they build and for whom, "linkedinHeadline": under 200 characters, role + proof + what they want next, ` +
      `"linkedinAbout": 3 short paragraphs, first person, "pinnedPost": the opening of a post worth pinning on X that shows their best work (2–3 sentences), ` +
      `"tips": 3 specific things to fix on their profiles this week}.`,
    temperature: 0.5,
  });
  return {
    xBio: String(data.xBio ?? "").slice(0, 200), linkedinHeadline: String(data.linkedinHeadline ?? "").slice(0, 240),
    linkedinAbout: String(data.linkedinAbout ?? "").slice(0, 2600), pinnedPost: String(data.pinnedPost ?? "").slice(0, 600),
    tips: (Array.isArray(data.tips) ? data.tips : []).map(String).slice(0, 5), at: new Date().toISOString(),
  };
}

/** Turn a rough work item into a portfolio-ready entry. */
export async function polishForPortfolio(m: Member, w: Work) {
  const { data } = await askJson<{ title: string; summary: string; details: string; stack: string[] }>({
    system: `You write portfolio entries for developers. ${STYLE} Never invent metrics, users, employers or features that aren't in the input. Answer with JSON only.`,
    prompt: `Person's focus: ${m.focus || "software developer"}\nKind: ${w.kind}\nTitle: ${w.title}\nTheir notes: ${w.summary}\n${w.details}\nStack: ${w.stack}\nLinks: ${JSON.stringify(linksOf(w))}\n\n` +
      `Return {"title": a clear name (keep theirs if it's fine), "summary": one sentence a recruiter understands, "details": 2 short paragraphs then 3–5 "- " bullets on what it does and what was built (Markdown), "stack": [technologies actually mentioned]}.`,
  });
  return {
    title: String(data.title || w.title).slice(0, 160),
    summary: String(data.summary || w.summary).slice(0, 400),
    details: String(data.details || w.details).slice(0, 4000),
    stack: (Array.isArray(data.stack) ? data.stack : []).map(String).join(", ").slice(0, 300) || w.stack,
  };
}

/** Write the resume from the person's profile and the work they picked. */
export async function writeResume(m: Member, profile: Profile, picked: Work[], target: string): Promise<Resume> {
  const projects = picked.map(w => ({ title: w.title, kind: w.kind, summary: w.summary, details: w.details.slice(0, 1200), stack: w.stack, links: linksOf(w), when: w.updated_at.slice(0, 7) }));
  const { data } = await askJson<Resume>({
    system: `You write one-page, ATS-friendly resumes for developers. ${STYLE} Use only facts from the input: never invent employers, dates, degrees, numbers or skills. Bullets start with a strong verb and say what was built and why it mattered. Answer with JSON only.`,
    prompt: `Target role: ${target || m.focus || "software developer roles"}\n\nProfile:\n${JSON.stringify(profile)}\n\nProjects and work to feature:\n${JSON.stringify(projects)}\n\n` +
      `Return the resume as JSON with keys: name, headline (fit to the target), location, email, website, links [{label,url}], summary (2–3 sentences), ` +
      `experience [{title, org, when, bullets: 2–4 strings}], projects [{title, when, summary, bullets: 2–3 strings, stack, link}] (feature the given projects, most relevant first, at most 5), ` +
      `education [{title, org, when}], skills [{group, items}] (3–4 groups, most relevant first). Keep it to one page.`,
    temperature: 0.4,
  });
  const arr = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  return {
    name: data.name || profile.name || m.name,
    headline: data.headline || profile.headline,
    location: data.location || profile.location,
    email: data.email || profile.email,
    website: data.website || profile.website,
    links: arr<{ label: string; url: string }>(data.links).length ? arr(data.links) : profile.links,
    summary: data.summary || profile.summary,
    experience: arr(data.experience),
    projects: arr(data.projects),
    education: arr(data.education).length ? arr(data.education) : profile.education,
    skills: arr(data.skills).length ? arr(data.skills) : profile.skills,
  };
}
