"""Supported interview dimensions and their distinct job-relevant evaluation scope."""

LABELS = {
    "domain_depth": "Domain Depth", "system_architecture": "System Architecture",
    "technical_communication": "Technical Communication",
    "customer_obsession": "Customer Obsession", "ownership": "Ownership",
    "invent_and_simplify": "Invent and Simplify", "are_right_a_lot": "Are Right, A Lot",
    "learn_and_be_curious": "Learn and Be Curious", "hire_and_develop_the_best": "Hire and Develop the Best",
    "insist_on_the_highest_standards": "Insist on the Highest Standards", "think_big": "Think Big",
    "bias_for_action": "Bias for Action", "frugality": "Frugality", "earn_trust": "Earn Trust",
    "dive_deep": "Dive Deep", "have_backbone_disagree_and_commit": "Have Backbone; Disagree and Commit",
    "deliver_results": "Deliver Results", "strive_to_be_earths_best_employer": "Strive to be Earth’s Best Employer",
    "success_and_scale_bring_broad_responsibility": "Success and Scale Bring Broad Responsibility",
}

CRITERION_GUIDE = {
    "domain_depth": "Evaluate correctness and depth of domain concepts, mechanisms, assumptions, methods and domain-specific tradeoffs that were actually probed. A material misconception on a claimed foundational method is direct negative evidence. Production deployment or end-to-end architecture is not a prerequisite for a Domain Depth rating unless the supplied role-specific criterion explicitly makes it relevant.",
    "system_architecture": "Evaluate system requirements, components and interfaces, scaling, reliability, failure handling and architectural tradeoffs that were actually probed. Do not substitute isolated algorithm knowledge for evidence about system design.",
    "learn_and_be_curious": """Evaluate how the candidate identifies a knowledge gap, investigates it, experiments,
checks results, changes an approach and applies or shares the learning. Distinguish initiative from assigned work,
accepting feedback from proactively seeking it, and trying a tool from understanding its limitations.
Concrete learning and changed practice can support a strength at L5 without expert knowledge across every topic.
An incorrect technical answer belongs primarily to Domain Depth; discuss it here only when the evidence shows
a relevant limitation in the learning or validation process. An unasked evaluation method is a coverage limit.
Do not require publications, invited talks, hobbies or access to particular resources to demonstrate curiosity.""",
    "technical_communication": """Evaluate effective communication with stakeholders, non-specialists, C-level executives,
partner departments and internal collaborators. Look for how the candidate identifies the audience's knowledge,
goals and concerns; selects the right level of detail, terminology, examples and format; translates technical
choices into business impact, risks and actionable options; listens, clarifies and checks shared understanding;
handles disagreement constructively; and makes decisions, responsibilities and follow-up actions clear.
Prefer concrete examples identifying the audience, the candidate's communication choices, feedback and outcome.
Observable interview explanations are evidence of those specific communication behaviors; reported project
interactions remain self-reported. Do not invent stakeholder success or infer it from a fluent interview answer.
Plain language is useful only when it conveys the relevant meaning or enables a decision. Calling a replacement
"a better model" without explaining its implications does not by itself demonstrate successful audience adaptation.
Separate an accessible part of an explanation from parts that remain jargon-heavy or omit the decision tradeoff.
No reported misunderstanding is not evidence that understanding was achieved. If audience feedback or outcome was
not established, say so without assuming either success or failure, and weigh the concrete behaviors observed.
Assess communication effectiveness, NOT Domain Depth or System Architecture. A failed algorithm question alone
is not a communication weakness; a technically strong answer alone is not communication strength. Technical
accuracy matters here when a specific communication example misleads its audience or obscures a decision.
Apply generic references to depth, reasoning and ownership to communication judgment and responsibility.
Do not score accent, native-language fluency, charisma, verbosity, executive exposure or job titles as competence.
Do not require every audience type to have been interviewed about. Unprobed communication situations are
coverage limitations, not capability failures. Only apply a resume gap to this criterion when the interview
actually probed a communication claim and showed a communication shortfall.""",
}

CRITERION_LEVEL_GUIDE = {
    "technical_communication": {
        "L4": "Clearly explain scoped work to teammates, ask clarifying questions, confirm understanding and communicate progress or blockers with support.",
        "L5": "Independently adapt explanations for technical and non-technical project stakeholders, clarify tradeoffs and risks, resolve misunderstandings and align next steps.",
        "L6": "Lead communication on ambiguous cross-functional work; tailor decision framing for executives and specialists, reconcile competing priorities and establish repeatable communication practices that sustain alignment.",
        "L7": "Shape communication around multi-team strategy and executive decisions; build durable alignment across organizations and mechanisms that help other leaders communicate complex choices effectively.",
    },
}

LEVEL_GUIDE = {
    "L4": "Foundational understanding and implementation/testing of well-scoped tasks, with appropriate support.",
    "L5": "Independent project-level problem solving and delivery: clarify requirements, make and explain relevant design tradeoffs, collaborate, troubleshoot and operate scoped solutions. Reusable work within a project is positive; organization-wide technical leadership and expert mastery across all adjacent domains are not prerequisites.",
    "L6": "Lead complex ambiguous work beyond individual implementation: justify alternatives and tradeoffs, coordinate stakeholders, guide others and create reusable improvements with impact beyond one delivery. Require concrete personal judgment and sustained ownership where probed, not merely participation or a senior title.",
    "L7": "Shape technical direction and long-term strategy across multiple teams with sustained organizational impact and mechanisms that enable other leaders.",
}

LEVEL_CALIBRATION = """Use the selected level, role and competency as the bar, not the next level.
For an L5 AI Specialist Solutions Architect, assess demonstrated project problem solving, sound relevant technical
judgment, collaboration, customer delivery and ability to explain practical choices. Do not silently substitute
a research-scientist rubric or L6 expectations of broad domain leadership and organization-wide mechanisms.
L5 still requires reliable reasoning on the core skills actually probed; tool exposure and willingness to learn
cannot compensate for material inability to design, explain or troubleshoot solutions required by this role.
Distinguish (a) an observed gap that materially blocks the selected role at this level, (b) a development area
compatible with meeting that bar, and (c) an untested area. Explain the impact instead of treating every weakness
as below-bar performance. A gap relevant to one competency is not automatically negative evidence for all others.
Specific project accounts can substantiate practical experience while remaining self-reported. Do not demand
external verification or reject all behavioral evidence simply because it is self-reported.
Credit only the candidate's described contribution to a team result. Do not attribute an entire metric change
to one person or one intervention without evidence about contributions and measurement conditions.
L6/L7 require stronger scope, judgment and impact than L5, but lack of questioning is not evidence of failure.
Neither a level label nor a requested recommendation is a reason to raise or lower a score."""
