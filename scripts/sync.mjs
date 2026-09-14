import { readFile, rename, writeFile } from "node:fs/promises";

const outputUrl = new URL("../catalog.json", import.meta.url);
const temporaryUrl = new URL("../catalog.json.tmp", import.meta.url);
const publicOrigin = "https://www.ncpssd.cn";
const catalogOrigins = ["https://m.ncpssd.cn", "https://www.ncpssd.cn"];

const journals = [
  ["cn-rural-economy", "中国农村经济", "94178X"],
  ["economic-management", "经济管理", "92588X"],
  ["accounting-research", "会计研究", "96456X"],
  ["economic-research", "经济研究", "95645X"],
  ["world-economy", "世界经济", "92713X"],
  ["financial-research", "金融研究", "97926X"],
  ["public-finance-research", "财政研究", "96682X"],
  ["china-economic-quarterly", "经济学（季刊）", "84307X"]
].map(([key, name, gch]) => ({ key, name, gch }));

const previous = await readPrevious();
const previousBySource = Map.groupBy(previous.items ?? [], (item) => item.sourceKey);
const items = [];
const status = [];

for (const journal of journals) {
  try {
    const current = await fetchJournal(journal);
    items.push(...current);
    status.push({ sourceKey: journal.key, ok: true, count: current.length, issue: current[0]?.issue ?? "" });
    process.stdout.write(`✓ ${journal.name} ${current[0]?.issue ?? ""} ${current.length} 篇\n`);
  } catch (error) {
    const fallback = previousBySource.get(journal.key) ?? [];
    items.push(...fallback);
    status.push({
      sourceKey: journal.key,
      ok: false,
      count: fallback.length,
      issue: fallback[0]?.issue ?? "",
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown_error"
    });
    process.stderr.write(`! ${journal.name} 更新失败，保留 ${fallback.length} 篇旧数据\n`);
  }
}

if (items.length < 20) throw new Error(`目录结果过少：${items.length}`);

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  provider: "国家哲学社会科学文献中心公开期刊目录",
  status,
  items: items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.sourceKey.localeCompare(b.sourceKey))
};

await writeFile(temporaryUrl, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
await rename(temporaryUrl, outputUrl);

async function fetchJournal(journal) {
  let lastError = new Error("no_catalog_origin");
  for (const origin of catalogOrigins) {
    const url = `${origin}/journal/details?gch=${journal.gch}&langType=1&nav=1`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PinkzzCatalog/1.0; +https://pinkzz.bowie.top)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9"
        }
      });
      if (!response.ok) throw new Error(`fetch_${response.status}`);
      const html = await response.text();
      const parsed = parseCatalog(html, journal);
      if (!parsed.length) {
        const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "untitled").slice(0, 50);
        throw new Error(`parse_empty_${html.length}_${title}`);
      }
      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("fetch_failed");
    }
  }
  throw lastError;
}

function parseCatalog(html, journal) {
  const issueText = decodeHtml(
    html.match(/<h2\s+class=['"]catalog-vol['"]>\s*([^<]+)/i)?.[1]
      ?? html.match(/<div\s+class=['"]catalog['"][^>]*>[\s\S]*?<h2[^>]*>\s*([^<]+)/i)?.[1]
      ?? "最新一期"
  ).trim();
  const issueMatch = issueText.match(/(20\d{2})年\s*第?(\d+)期/);
  const year = issueMatch?.[1] ?? String(new Date().getUTCFullYear());
  const issueNumber = Number(issueMatch?.[2] ?? 1);
  const month = journal.key === "china-economic-quarterly"
    ? Math.min(12, Math.max(1, issueNumber * 2))
    : Math.min(12, Math.max(1, issueNumber));
  const publishedAt = `${year}-${String(month).padStart(2, "0")}-01`;
  const articles = new Map();

  for (const block of html.match(/<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi) ?? []) {
    const sourceId = block.match(/data-id=['"]([A-Z0-9_-]{8,})['"]/i)?.[1];
    const title = attributeAfterClass(block, "caption", "title") || attributeAfterClass(block, "title", "title");
    if (!sourceId || !title || articles.has(sourceId)) continue;
    const addHandleArgs = block.match(/onclick="AddHandleCount\(([\s\S]*?)\)"/i)?.[1] ?? "";
    const quotedArgs = [...addHandleArgs.matchAll(/'([^']*)'/g)].map((match) => decodeHtml(match[1]));
    const author = cleanupAuthors(attributeAfterClass(block, "writer", "title") || quotedArgs.at(-2) || "");
    const detailPath = block.match(/openDetail\(['"]([^'"]+)['"]/i)?.[1];
    const readPath = block.match(/['"](\/Literature\/readurl\?id=[^'"]+)['"]/i)?.[1];
    const topic = classifyTitle(title, journal.key);
    articles.set(sourceId, {
      id: `ncp-${sourceId.toLowerCase()}`,
      sourceKey: journal.key,
      itemType: "paper",
      title,
      sourceName: journal.name,
      author,
      issue: issueText,
      publishedAt,
      originalUrl: absoluteUrl(detailPath || readPath || `/journal/details?gch=${journal.gch}&langType=1&nav=1`),
      downloadUrl: absoluteUrl(readPath || detailPath || `/journal/details?gch=${journal.gch}&langType=1&nav=1`),
      category: topic.category,
      tags: topic.tags,
      rightsStatus: "source_download"
    });
  }
  return [...articles.values()].slice(0, 40);
}

function attributeAfterClass(html, className, attribute) {
  const classIndex = html.search(new RegExp(`class=['"][^'"]*\\b${className}\\b[^'"]*['"]`, "i"));
  if (classIndex < 0) return "";
  const portion = html.slice(classIndex, classIndex + 900);
  const match = portion.match(new RegExp(`${attribute}=(['"])([\\s\\S]*?)\\1`, "i"));
  return stripTags(decodeHtml(match?.[2] ?? ""));
}

function classifyTitle(title, sourceKey) {
  const rules = [
    [/农村|农业|农户|乡村|粮食|农地|返贫/, "农商管理", "三农"],
    [/人工智能|生成式|算法|数字化|数据|机器|自动化/, "AI与组织", "数字化"],
    [/资本市场|股票|债券|融资|银行|金融|信贷|IPO|投资者/, "资本市场", "资本市场"],
    [/会计|审计|披露|内部控制|公司治理|董事|企业|创新|供应链/, "企业管理", "企业管理"]
  ];
  for (const [pattern, category, tag] of rules) {
    if (pattern.test(title)) return { category, tags: [category, tag, "最新一期"] };
  }
  if (sourceKey === "cn-rural-economy") return { category: "农商管理", tags: ["农商管理", "最新一期"] };
  if (["financial-research", "public-finance-research"].includes(sourceKey)) {
    return { category: "资本市场", tags: ["资本市场", "最新一期"] };
  }
  return { category: "企业管理", tags: ["企业管理", "最新一期"] };
}

function absoluteUrl(value) {
  try {
    return new URL(value, publicOrigin).toString();
  } catch {
    return publicOrigin;
  }
}

function cleanupAuthors(value) {
  return value.replace(/\[\d+(?:,\d+)*\]/g, "").replaceAll(";", "、").replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–" };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(outputUrl, "utf8"));
  } catch {
    return { items: [] };
  }
}
