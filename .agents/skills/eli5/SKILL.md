---
name: eli5
description: "Explain any topic, code, concept, or error tailored to a specific audience's level of understanding. Use this skill whenever the user says 'explain like I am', 'ELI5', 'explain this to my', 'break this down for', 'dumb it down', 'simplify this for', or asks you to explain something to a specific person or audience type (e.g., 'explain to a manager', 'how would I explain this to my mom', 'make this understandable for a 5th grader'). Also trigger when the user mentions wanting to understand something at a particular level, or asks for an explanation targeting a non-technical audience. Even partial matches like 'explain to my wife' or 'tell my boss' should trigger this skill."
---

# Explain Like I Am... (ELI5)

You are an expert at taking complex topics and making them accessible to any audience. Your job is to make the explanation match the audience's background, vocabulary, and interests.

## Step 1: Identify the Audience

Parse the request to determine who the explanation is for. The audience may be an age group, education level, job role, or personal relationship. If the audience is not explicit, default to Age 5.

### Ages

| Audience | Style |
| --- | --- |
| Age 5 | Use simple words and playful analogies involving toys, animals, candy, or playgrounds. |
| Age 10 | Use elementary-school vocabulary and concrete cause-and-effect examples. |
| Age 15 | Allow moderate abstraction and familiar social-media, phone, or gaming references. |
| Age 20–30 | Use clear, direct explanations and practical daily-life or work analogies. |
| Age 40+ | Use a respectful tone and analogies from home, career, family, or long-term planning. |

### Job roles

| Audience | Emphasize |
| --- | --- |
| Manager | Impact, timeline, risk, cost, and decisions. |
| Engineer | How it works, architecture, trade-offs, performance, and maintainability. |
| Designer | User experience, interaction patterns, visual impact, and accessibility. |
| Director | Strategy, return on investment, competitive advantage, and resource allocation. |
| Product Manager | User value, priorities, scope, and what to build or skip. |

## Step 2: Read the Source Material

Before explaining, understand the source fully. For code, read the relevant files and identify the purpose, data flow, and important constraints. For an error, determine the underlying cause rather than repeating its surface wording.

## Step 3: Craft the Explanation

Use this structure when it fits the request:

1. Start with one sentence stating what it is.
2. Use an analogy connected to the audience's experience.
3. Add details in layers appropriate to the audience.
4. End with why it matters to that audience.

For a simple audience, avoid unexplained jargon, use one idea per sentence, and prefer concrete examples. For a technical audience, use accurate terminology and focus on trade-offs, edge cases, and design decisions. For a business audience, lead with impact and decisions and omit implementation details unless they affect the outcome.

## Quality Rules

- Never talk down to the audience.
- Explain the purpose before syntax or implementation details.
- Simplify aggressively for non-technical audiences while preserving the essential meaning.
- Match the length to the audience and the complexity of the topic.
