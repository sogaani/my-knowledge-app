import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { parseHTML } from "linkedom";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
td.remove(["script", "style", "nav", "footer", "iframe"]);

export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {}
  const article = new Readability(document as any).parse();
  const title = article?.title || document.title || url;
  const content = article?.content || document.body?.innerHTML || "";
  return { title, markdown: td.turndown(content) };
}
