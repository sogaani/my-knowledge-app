import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";

const GOLD_PREFIX = "300_gold/";
/** In-app route for a repo-relative .md path: Gold pages have their own view (they are not notes). */
export const routeFor = (path: string) => (path.startsWith(GOLD_PREFIX) ? `/gold/${path.slice(GOLD_PREFIX.length).replace(/\.md$/, "")}` : `/note/${path}`);

/** Render note markdown: resolves relative .md links to /note/<path> (or /gold/<name>), folds `> [!spoiler]-` blocks. */
export default function Md({ text, basePath }: { text: string; basePath: string }) {
  const parts = splitSpoilers(text);
  return (
    <div className="md">
      {parts.map((p, i) =>
        p.spoiler ? (
          <details key={i} className="spoiler"><summary>ネタバレ</summary><Body text={p.text} basePath={basePath} /></details>
        ) : (
          <Body key={i} text={p.text} basePath={basePath} />
        ),
      )}
    </div>
  );
}

function Body({ text, basePath }: { text: string; basePath: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          if (href && !/^https?:|^mailto:|^#/.test(href) && href.endsWith(".md")) {
            return <Link to={routeFor(resolve(basePath, decodeURIComponent(href)))}>{children}</Link>;
          }
          return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function resolve(basePath: string, href: string): string {
  const parts = basePath.split("/").slice(0, -1);
  for (const seg of href.split("/")) {
    if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function splitSpoilers(text: string): { spoiler: boolean; text: string }[] {
  const out: { spoiler: boolean; text: string }[] = [];
  const lines = text.split("\n");
  let buf: string[] = [], inSp = false;
  const flush = () => { if (buf.length) out.push({ spoiler: inSp, text: buf.join("\n") }); buf = []; };
  for (const line of lines) {
    if (/^>\s*\[!spoiler\]-?/i.test(line)) { flush(); inSp = true; continue; }
    if (inSp && !line.startsWith(">")) { flush(); inSp = false; }
    buf.push(inSp ? line.replace(/^>\s?/, "") : line);
  }
  flush();
  return out;
}
