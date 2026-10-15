"""Summarize a veraPDF XML report (CI, job "pdfa" in .github/workflows/app.yml).

Usage: python -I verapdf_summary.py REPORT.xml (expect-compliant | expect-refused)

Prints one line per file (compliant or not) and, for the files that fail, every failed rule
with its clause, test number, description and first error message. With "expect-compliant" the
exit code is 1 when any file is not compliant or could not be validated; with "expect-refused"
(the files the app refuses to convert) it only reports, since those failing is the point.
"""
import sys
import xml.etree.ElementTree as ET


def local(tag):
    return tag.rsplit("}", 1)[-1]


def children(node, name):
    return [c for c in node if local(c.tag) == name]


def first(node, name):
    for c in node.iter():
        if local(c.tag) == name:
            return c
    return None


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("expect-compliant", "expect-refused"):
        print(__doc__)
        return 2
    path, mode = sys.argv[1], sys.argv[2]
    root = ET.parse(path).getroot()
    jobs = [j for j in root.iter() if local(j.tag) == "job"]
    if not jobs:
        print("veraPDF report has no files")
        return 1 if mode == "expect-compliant" else 0
    bad = 0
    for job in jobs:
        item = first(job, "item")
        name_el = first(item, "name") if item is not None else None
        name = name_el.text.rsplit("/", 1)[-1] if name_el is not None and name_el.text else "?"
        report = first(job, "validationReport")
        if report is None:
            # A parse failure or an exception: veraPDF could not validate the file at all.
            message = first(job, "exceptionMessage")
            print(f"ERROR     {name}: {message.text if message is not None else 'not validated'}")
            bad += 1
            continue
        compliant = report.get("isCompliant") == "true"
        print(f"{'OK       ' if compliant else 'FAILED   '} {name}")
        if compliant:
            continue
        bad += 1
        details = first(report, "details")
        for rule in children(details, "rule") if details is not None else []:
            if rule.get("status") != "failed":
                continue
            desc = first(rule, "description")
            msg = first(rule, "errorMessage")
            print(f"    {rule.get('clause')}-{rule.get('testNumber')} ({rule.get('failedChecks')}x): "
                  f"{(desc.text or '').strip() if desc is not None else ''}")
            if msg is not None and msg.text:
                print(f"        {msg.text.strip()[:300]}")
    total = len(jobs)
    if mode == "expect-compliant":
        print(f"\nveraPDF PDF/A-2b: {total - bad}/{total} compliant")
        return 1 if bad else 0
    print(f"\nRefused by the app, as expected not compliant: {bad}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
