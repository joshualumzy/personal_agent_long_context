# SME Employee Context Agent

## Language

**SME Employee Context Agent**:
A personal workplace agent that helps an employee reconstruct company context, relate it to their responsibilities, and identify a supported next step.
_Avoid_: General-purpose company chatbot, autonomous employee

**Company Artifact**:
An employee-visible record produced by ordinary company work, such as a message, ticket, document, meeting transcript, pull request, alert, invoice, or support record.
_Avoid_: Ground truth, Memory

**Company Evidence**:
A Company Artifact or passage retrieved to support an answer. Evidence remains attributable to its source and time.
_Avoid_: Model knowledge, answer key

**Employee Context**:
The employee's role, department, assignments, and confirmed personal working context used to explain why Company Evidence matters to them.
_Avoid_: All records mentioning the employee

**Personal Memory**:
Employee-specific context retained across interactions with provenance and user control. It is distinct from Company Evidence.
_Avoid_: Company document store, chat history

**Source Citation**:
An inspectable reference from an answer to the Company Artifact that supports a factual claim.
_Avoid_: Unverified source identifier

**Related Artifact**:
A Company Artifact connected to another by an explicit OrgForge artifact reference.
_Avoid_: Semantically similar document

**Proposed Action**:
A non-executed draft of a workplace change, such as a ticket update or email response, supported by cited evidence.
_Avoid_: Tool execution

**Approval**:
The employee's explicit decision to execute a specific unchanged Proposed Action.
_Avoid_: General permission, model confidence

**Evaluation Oracle**:
OrgForge simulation state, events, registries, scores, and expected answers reserved exclusively for evaluation. It must never enter the runtime knowledge store or agent context.
_Avoid_: Company Evidence

**Insufficient Evidence**:
The state in which retrieved Company Evidence cannot support a reliable answer. The agent names the missing information rather than guessing.
_Avoid_: Model failure
