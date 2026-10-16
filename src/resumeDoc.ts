// Render a Resume to PDF (pdfkit) and Word (docx). One column, real text, standard
// headings, so applicant-tracking systems read it cleanly.
import PDFDocument from "pdfkit";
import { BorderStyle, Document, ExternalHyperlink, Packer, Paragraph, TextRun } from "docx";
import { Resume } from "./work";

const contactLine = (r: Resume) => [r.location, r.email, r.website, ...r.links.map(l => l.url)].filter(Boolean).join("  ·  ");

export function resumePdf(r: Resume): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 46, bottom: 46, left: 52, right: 52 }, info: { Title: `${r.name} — Resume`, Author: r.name } });
    const chunks: Buffer[] = [];
    doc.on("data", c => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 104;
    const ink = "#111111", muted = "#555555", accent = "#0A7F86";

    doc.font("Helvetica-Bold").fontSize(22).fillColor(ink).text(r.name || "Your name");
    if (r.headline) doc.font("Helvetica").fontSize(11.5).fillColor(accent).text(r.headline);
    const contact = contactLine(r);
    if (contact) doc.moveDown(0.2).font("Helvetica").fontSize(9).fillColor(muted).text(contact, { width: W });

    const section = (title: string) => {
      doc.moveDown(0.8).font("Helvetica-Bold").fontSize(10.5).fillColor(ink).text(title.toUpperCase(), { characterSpacing: 1 });
      const y = doc.y + 2;
      doc.moveTo(52, y).lineTo(52 + W, y).lineWidth(1.2).strokeColor(ink).stroke();
      doc.moveDown(0.45);
    };
    const bullets = (items: string[] | undefined) => {
      for (const b of items ?? []) doc.font("Helvetica").fontSize(9.5).fillColor(ink).text(`•  ${b}`, { width: W, indent: 8, paragraphGap: 1.5 });
    };
    const row = (left: string, right: string) => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(ink).text(left, 52, y, { width: W - 120 });
      const after = doc.y;
      if (right) doc.font("Helvetica").fontSize(9).fillColor(muted).text(right, 52 + W - 120, y + 1, { width: 120, align: "right" });
      doc.y = Math.max(after, doc.y); doc.x = 52;
    };

    if (r.summary) { section("Summary"); doc.font("Helvetica").fontSize(10).fillColor(ink).text(r.summary, { width: W, lineGap: 1.5 }); }

    if (r.experience?.length) {
      section("Experience");
      for (const e of r.experience) {
        row([e.title, e.org].filter(Boolean).join(" — "), e.when || "");
        if (e.summary && !e.bullets?.length) doc.font("Helvetica").fontSize(9.5).fillColor(ink).text(e.summary, { width: W });
        bullets(e.bullets);
        doc.moveDown(0.35);
      }
    }
    if (r.projects?.length) {
      section("Projects");
      for (const p of r.projects) {
        row(p.title, p.when || "");
        if (p.summary) doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(ink).text(p.summary, { width: W });
        bullets(p.bullets);
        const meta = [p.stack, p.link].filter(Boolean).join("  ·  ");
        if (meta) doc.font("Helvetica").fontSize(8.5).fillColor(muted).text(meta, { width: W });
        doc.moveDown(0.35);
      }
    }
    if (r.skills?.length) {
      section("Skills");
      for (const s of r.skills) {
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ink).text(`${s.group}: `, { continued: true }).font("Helvetica").text((s.items ?? []).join(", "), { width: W });
      }
    }
    if (r.education?.length) {
      section("Education");
      for (const e of r.education) row([e.title, e.org].filter(Boolean).join(" — "), e.when || "");
    }
    doc.end();
  });
}

export async function resumeDocx(r: Resume): Promise<Buffer> {
  const H = (t: string) => new Paragraph({
    spacing: { before: 220, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: "111111", space: 2 } },
    children: [new TextRun({ text: t.toUpperCase(), bold: true, size: 21, characterSpacing: 20 })],
  });
  const line = (left: string, right: string) => new Paragraph({
    spacing: { before: 100 },
    tabStops: [{ type: "right", position: 9600 }],
    children: [new TextRun({ text: left, bold: true, size: 21 }), ...(right ? [new TextRun({ text: `\t${right}`, size: 18, color: "555555" })] : [])],
  });
  const bullet = (t: string) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 30 }, children: [new TextRun({ text: t, size: 19 })] });
  const text = (t: string, opts: { italics?: boolean; size?: number; color?: string } = {}) => new Paragraph({ children: [new TextRun({ text: t, size: opts.size ?? 20, italics: opts.italics, color: opts.color })] });

  const kids: Paragraph[] = [
    new Paragraph({ children: [new TextRun({ text: r.name || "Your name", bold: true, size: 44 })] }),
  ];
  if (r.headline) kids.push(new Paragraph({ children: [new TextRun({ text: r.headline, size: 23, color: "0A7F86" })] }));
  const contact = contactLine(r);
  if (contact) kids.push(new Paragraph({ spacing: { before: 40 }, children: [new TextRun({ text: contact, size: 18, color: "555555" })] }));

  if (r.summary) kids.push(H("Summary"), text(r.summary));
  if (r.experience?.length) {
    kids.push(H("Experience"));
    for (const e of r.experience) {
      kids.push(line([e.title, e.org].filter(Boolean).join(" — "), e.when || ""));
      if (e.summary && !e.bullets?.length) kids.push(text(e.summary, { size: 19 }));
      for (const b of e.bullets ?? []) kids.push(bullet(b));
    }
  }
  if (r.projects?.length) {
    kids.push(H("Projects"));
    for (const p of r.projects) {
      kids.push(line(p.title, p.when || ""));
      if (p.summary) kids.push(text(p.summary, { italics: true, size: 19 }));
      for (const b of p.bullets ?? []) kids.push(bullet(b));
      const meta: (TextRun | ExternalHyperlink)[] = [];
      if (p.stack) meta.push(new TextRun({ text: p.stack, size: 17, color: "555555" }));
      if (p.link) meta.push(new TextRun({ text: p.stack ? "  ·  " : "", size: 17, color: "555555" }), new ExternalHyperlink({ link: p.link, children: [new TextRun({ text: p.link, size: 17, style: "Hyperlink" })] }));
      if (meta.length) kids.push(new Paragraph({ children: meta }));
    }
  }
  if (r.skills?.length) {
    kids.push(H("Skills"));
    for (const s of r.skills) kids.push(new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: `${s.group}: `, bold: true, size: 19 }), new TextRun({ text: (s.items ?? []).join(", "), size: 19 })] }));
  }
  if (r.education?.length) {
    kids.push(H("Education"));
    for (const e of r.education) kids.push(line([e.title, e.org].filter(Boolean).join(" — "), e.when || ""));
  }

  const doc = new Document({
    creator: r.name || "Abro",
    title: `${r.name} — Resume`,
    styles: { default: { document: { run: { font: "Calibri" } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children: kids }],
  });
  return Packer.toBuffer(doc);
}
