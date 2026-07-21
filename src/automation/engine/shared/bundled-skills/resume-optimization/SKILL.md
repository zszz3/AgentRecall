---
name: resume-optimization
description: Resume structure, achievement bullet formulas, ATS optimization, and job-targeted tailoring for software engineers. Use when reviewing resumes, crafting achievement bullets, extracting keywords from job descriptions, or tailoring content for specific roles.
argument-hint: <job-description-text-or-url>
allowed-tools: Read, Glob, Grep, Write, AskUserQuestion, Skill, WebFetch
---

# Resume Optimization

Comprehensive guidance for creating effective software engineering resumes that pass ATS systems and resonate with hiring managers.

## When to Use This Skill

- Reviewing or improving a software engineer's resume
- Crafting impactful achievement bullets from work experience
- Optimizing resume content for ATS keyword matching
- Tailoring a resume for a specific job description
- Understanding modern resume structure and formatting

## Core Principles

### The Resume's Purpose

A resume is a **marketing document**, not a job history. Its purpose is to:

1. Pass ATS screening (keyword matching)
2. Capture a recruiter's attention (6-second scan)
3. Demonstrate value through quantified achievements
4. Secure an interview opportunity

### What Makes Engineering Resumes Different

Software engineering resumes should emphasize:

- **Technical impact**: Specific technologies, scale, and performance improvements
- **Business outcomes**: Revenue, cost savings, user growth, time savings
- **Leadership signals**: Mentoring, cross-team collaboration, technical decisions
- **Quantification**: Numbers that demonstrate scope and impact

## Resume Structure Quick Reference

### Recommended Section Order

1. **Contact Information** - Name, email, phone, LinkedIn, GitHub (optional)
2. **Professional Summary** (optional) - 2-3 sentences for senior roles
3. **Skills** - Technical skills organized by category
4. **Experience** - Reverse chronological, 3-5 most relevant roles
5. **Projects** (optional) - For junior engineers or career changers
6. **Education** - Degrees, certifications, relevant coursework

### Length Guidelines

| Experience Level | Recommended Length |
| ---------------- | ------------------ |
| 0-5 years | 1 page |
| 5-10 years | 1-2 pages |
| 10+ years | 2 pages max |

### Formatting Essentials

- **Font**: Clean, readable (Calibri, Arial, Garamond - 10-12pt)
- **Margins**: 0.5-1 inch
- **Format**: PDF (preserves formatting)
- **File naming**: `FirstName_LastName_Resume.pdf`

## Achievement Bullet Formula

### Action Verb + Specific Task + Quantifiable Result

```text
[Strong Action Verb] [specific task/project] using [tools/methods], resulting in [quantified outcome].
```

### Technical Project Bullets

For software projects, do not write a feature list. Each bullet should show:

1. **Problem** - the non-trivial engineering challenge.
2. **Approach** - the abstraction, architecture, algorithm, integration, or reliability mechanism used.
3. **Result** - the measurable or concrete engineering outcome.

Prefer engineering mechanisms over raw variable names or local implementation trivia. For example, write "source-file state snapshot with metadata version checks" instead of "mtime / size / indexed_at", unless those fields are directly relevant to the target role.

Avoid weak verbs such as "supported", "integrated", or "implemented" unless followed by the concrete design. Good project bullets should explain *how* the capability works, not only that it exists.

When possible, include an order-of-magnitude result:

```text
Optimized unchanged-session indexing with source-file state snapshots and metadata version checks, skipping parsing and full-text index rebuilds for unchanged sessions and reducing a 250-session reload from 2s+ to 10ms-level latency.
```

For projects involving many named products, mention product names once in the project description, then use generic terms such as "Agent", "source", "provider", or "target runtime" in bullets to avoid noisy repetition.

Do not overclaim concurrency or distributed systems. If the implementation uses batched writes and yields the event loop, call it "batched processing" or "event-loop yielding", not "parallel indexing".

### Strong Action Verbs by Category

| Category | Verbs |
| -------- | ----- |
| Technical | Architected, Built, Deployed, Engineered, Implemented, Integrated, Migrated, Optimized, Refactored, Scaled |
| Design | Analyzed, Designed, Documented, Modeled, Prototyped, Researched, Specified |
| Leadership | Championed, Coached, Led, Mentored, Pioneered, Spearheaded |
| Impact | Achieved, Boosted, Delivered, Improved, Increased, Reduced, Saved, Streamlined |

### Quantification Types

- **Time**: "Reduced deploy time from 2 hours to 15 minutes"
- **Money**: "Saved $50K/year in infrastructure costs"
- **Scale**: "Scaled system to handle 1M daily requests"
- **Improvement**: "Improved test coverage from 40% to 85%"
- **Frequency**: "Reduced support tickets by 70%"

## ATS Optimization

### What ATS Systems Look For

1. **Keyword matching** - Skills, tools, technologies from job description
2. **Job title alignment** - Titles that match or relate to the target role
3. **Section structure** - Standard sections that ATS can parse
4. **Clean formatting** - No tables, columns, graphics, or headers/footers

### ATS-Friendly Practices

- Use standard section headings ("Experience", "Skills", "Education")
- Include both spelled-out terms AND acronyms ("Continuous Integration (CI)")
- Mirror exact phrases from job descriptions
- Avoid images, icons, or non-text elements
- Use bullet points (-, *, •) not custom symbols

### Keyword Extraction Strategy

When tailoring for a job description:

1. **Identify required skills** - Listed in "Required" or "Must have" sections
2. **Note preferred skills** - Listed in "Nice to have" or "Preferred"
3. **Capture soft skills** - Leadership, communication, collaboration terms
4. **Extract action verbs** - What the job says you'll "do" or "lead"
5. **Match technologies** - Specific tools, languages, frameworks mentioned

## Tailoring Strategy

### The 80/20 Rule

- **80% base resume**: Core experience and skills that apply broadly
- **20% customization**: Targeted adjustments for each application

### What to Customize

1. **Professional Summary** - Align with job's key requirements
2. **Skills Section** - Reorder to prioritize job's requirements
3. **Achievement Bullets** - Emphasize relevant accomplishments
4. **Keywords** - Incorporate exact terms from job description

### Red Flags to Avoid

- Generic objective statements ("Seeking a challenging position...")
- Job duties instead of achievements ("Responsible for...")
- Unexplained gaps without context
- Typos or inconsistent formatting
- Outdated technologies prominently featured

## References

For detailed guidance on specific topics:

- [Resume Structure Guide](references/resume-structure.md) - Section order, formatting, length
- [Achievement Formula Guide](references/achievement-formula.md) - Transforming experience into impact
- [ATS Keywords Guide](references/ats-keywords.md) - Keyword extraction and optimization
- [Tailoring Guide](references/tailoring-guide.md) - Matching resume to job description

## Related Resources

- `achievement-bullet` output style - Format for achievement bullets
- `/soft-skills:track-win` skill - Transform descriptions into achievement bullets
- `resume-coach` agent - Interactive resume improvement

## User-Facing Interface

When invoked directly by the user, this skill tailors a resume for a specific job description.

### Execution Workflow

1. **Parse Arguments** - Extract job description text or URL from `$ARGUMENTS`. If URL provided, fetch the job description content. If no arguments, ask the user for the job description.
2. **Extract Keywords** - Analyze the job description for required skills, preferred skills, soft skills, action verbs, and specific technologies.
3. **Find Resume** - Search for the user's resume in common locations (current directory, `docs/`, `~/.claude/temp/`). If not found, ask the user for the resume location.
4. **Analyze Gaps** - Compare resume content against job description keywords. Identify missing keywords, weak achievement bullets, and alignment opportunities.
5. **Generate Tailored Output** - Produce:
   - Keyword match report (matched vs missing)
   - Rewritten achievement bullets incorporating job keywords
   - Suggested skills section reordering
   - Professional summary tailored to the role
   - ATS optimization recommendations
6. **Offer to Apply Changes** - Ask user if they want changes applied directly to their resume file.

## Version History

- v1.0.0 (2025-12-23): Initial release with core resume optimization guidance
