import type { PostgresMigration } from "./database";

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [{
  version: 1,
  name: "create unified AgentRecall schema",
  statements: [
    "CREATE EXTENSION IF NOT EXISTS pg_trgm",
    `
      CREATE TABLE agent_recall.environments (
        id text PRIMARY KEY,
        kind text NOT NULL,
        label text NOT NULL,
        wsl_distribution text,
        host_alias text,
        host text,
        "user" text,
        port integer,
        auth_mode text NOT NULL,
        identity_file text,
        enabled boolean NOT NULL DEFAULT true,
        sync_state text NOT NULL DEFAULT 'idle',
        last_synced_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      INSERT INTO agent_recall.environments (
        id, kind, label, host_alias, host, "user", port, auth_mode,
        identity_file, enabled, sync_state, last_synced_at, last_error,
        created_at, updated_at
      )
      VALUES (
        'local', 'local', 'Local', null, null, null, null, 'none',
        null, true, 'idle', null, null, now(), now()
      )
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE agent_recall.sessions (
        session_key text PRIMARY KEY,
        raw_id text NOT NULL,
        source text NOT NULL,
        environment_id text NOT NULL REFERENCES agent_recall.environments(id),
        project_path text NOT NULL,
        file_path text NOT NULL,
        original_title text NOT NULL,
        first_question text NOT NULL,
        started_at timestamptz NOT NULL,
        file_mtime_ms double precision NOT NULL,
        file_size bigint NOT NULL,
        pr_url text,
        pr_number integer,
        custom_title text,
        favorited boolean NOT NULL DEFAULT false,
        pinned boolean NOT NULL DEFAULT false,
        hidden boolean NOT NULL DEFAULT false,
        last_opened_at timestamptz,
        last_resumed_at timestamptz,
        message_count integer NOT NULL DEFAULT 0,
        turn_count integer NOT NULL DEFAULT 0,
        input_tokens bigint NOT NULL DEFAULT 0,
        output_tokens bigint NOT NULL DEFAULT 0,
        cached_input_tokens bigint NOT NULL DEFAULT 0,
        reasoning_output_tokens bigint NOT NULL DEFAULT 0,
        total_tokens bigint NOT NULL DEFAULT 0,
        indexed_at timestamptz NOT NULL,
        is_subagent boolean NOT NULL DEFAULT false,
        parent_session_id text,
        ai_summary text,
        ai_summary_model text,
        ai_summary_at timestamptz,
        ai_summary_basis double precision,
        codex_history_mode text,
        codex_tool_call_state jsonb
      );

      CREATE TABLE agent_recall.session_raw_events (
        session_key text NOT NULL REFERENCES agent_recall.sessions(session_key) ON DELETE CASCADE,
        event_index integer NOT NULL,
        event_id text,
        kind text NOT NULL,
        role text,
        occurred_at timestamptz,
        payload jsonb NOT NULL,
        PRIMARY KEY (session_key, event_index)
      );

      CREATE TABLE agent_recall.session_message_events (
        session_key text NOT NULL REFERENCES agent_recall.sessions(session_key) ON DELETE CASCADE,
        message_index integer NOT NULL,
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY (session_key, message_index)
      );

      CREATE TABLE agent_recall.session_turns (
        id text PRIMARY KEY,
        session_key text NOT NULL REFERENCES agent_recall.sessions(session_key) ON DELETE CASCADE,
        turn_index integer NOT NULL,
        source_message_index integer,
        synthetic boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'completed',
        source_turn_id text,
        started_at timestamptz,
        ended_at timestamptz,
        duration_ms bigint,
        time_to_first_token_ms bigint,
        abort_reason text,
        user_text text NOT NULL DEFAULT '',
        assistant_text text NOT NULL DEFAULT '',
        tool_text text NOT NULL DEFAULT '',
        search_text text NOT NULL DEFAULT '',
        search_vector tsvector GENERATED ALWAYS AS (
          to_tsvector('simple'::regconfig, search_text)
        ) STORED,
        input_tokens bigint NOT NULL DEFAULT 0,
        output_tokens bigint NOT NULL DEFAULT 0,
        cached_input_tokens bigint NOT NULL DEFAULT 0,
        reasoning_output_tokens bigint NOT NULL DEFAULT 0,
        total_tokens bigint NOT NULL DEFAULT 0,
        error_count integer NOT NULL DEFAULT 0,
        tool_names text[] NOT NULL DEFAULT '{}'::text[],
        derivation_version integer NOT NULL,
        UNIQUE (session_key, turn_index)
      );

      CREATE TABLE agent_recall.turn_messages (
        turn_id text NOT NULL REFERENCES agent_recall.session_turns(id) ON DELETE CASCADE,
        message_index integer NOT NULL,
        source_message_index integer,
        role text NOT NULL,
        content text NOT NULL,
        occurred_at timestamptz,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (turn_id, message_index)
      );

      CREATE TABLE agent_recall.trace_spans (
        id text PRIMARY KEY,
        turn_id text NOT NULL REFERENCES agent_recall.session_turns(id) ON DELETE CASCADE,
        parent_span_id text REFERENCES agent_recall.trace_spans(id) ON DELETE CASCADE,
        span_index integer NOT NULL,
        kind text NOT NULL,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'completed',
        started_at timestamptz,
        ended_at timestamptz,
        call_id text,
        input jsonb,
        output jsonb,
        error text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (turn_id, span_index)
      );

      CREATE TABLE agent_recall.token_events (
        session_key text NOT NULL REFERENCES agent_recall.sessions(session_key) ON DELETE CASCADE,
        dedupe_key text NOT NULL,
        occurred_at timestamptz NOT NULL,
        input_tokens bigint NOT NULL DEFAULT 0,
        output_tokens bigint NOT NULL DEFAULT 0,
        cached_input_tokens bigint NOT NULL DEFAULT 0,
        reasoning_output_tokens bigint NOT NULL DEFAULT 0,
        total_tokens bigint NOT NULL DEFAULT 0,
        source_turn_id text,
        PRIMARY KEY (session_key, dedupe_key)
      );

      CREATE TABLE agent_recall.tags (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL UNIQUE
      );

      CREATE TABLE agent_recall.session_tags (
        session_key text NOT NULL REFERENCES agent_recall.sessions(session_key) ON DELETE CASCADE,
        tag_id bigint NOT NULL REFERENCES agent_recall.tags(id) ON DELETE CASCADE,
        PRIMARY KEY (session_key, tag_id)
      );

      CREATE TABLE agent_recall.skill_usage_sources (
        source_path text PRIMARY KEY,
        agent text NOT NULL,
        kind text NOT NULL,
        mtime_ms double precision NOT NULL,
        file_size bigint NOT NULL,
        scanned_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.skill_usage_events (
        source_path text NOT NULL REFERENCES agent_recall.skill_usage_sources(source_path) ON DELETE CASCADE,
        event_index integer NOT NULL,
        agent text NOT NULL,
        skill text NOT NULL,
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY (source_path, event_index)
      );

      CREATE TABLE agent_recall.skill_sync_bindings (
        local_skill_path text PRIMARY KEY,
        portable_identity text NOT NULL DEFAULT '',
        remote_skill_id text NOT NULL UNIQUE,
        remote_updated_at timestamptz NOT NULL,
        remote_version integer NOT NULL DEFAULT 1,
        last_content_hash text NOT NULL DEFAULT '',
        last_synced_at timestamptz NOT NULL,
        direction text NOT NULL
      );

      CREATE TABLE agent_recall.session_sync_bindings (
        local_session_key text PRIMARY KEY REFERENCES agent_recall.sessions(session_key) ON DELETE CASCADE,
        remote_session_id text NOT NULL UNIQUE,
        last_local_revision text NOT NULL,
        last_remote_revision text NOT NULL,
        last_synced_at timestamptz NOT NULL,
        direction text NOT NULL
      );

      CREATE TABLE agent_recall.api_provider_keys (
        target text NOT NULL,
        provider_id text NOT NULL,
        api_key text NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (target, provider_id)
      );

      CREATE TABLE agent_recall.session_migrations (
        id text PRIMARY KEY,
        source_session_key text NOT NULL,
        source_agent text NOT NULL,
        target_agent text NOT NULL,
        target_session_id text NOT NULL,
        target_file_path text NOT NULL,
        strategy text NOT NULL,
        created_at timestamptz NOT NULL
      );

      CREATE INDEX sessions_visibility_idx
        ON agent_recall.sessions (hidden, favorited, pinned);
      CREATE INDEX sessions_source_idx
        ON agent_recall.sessions (source);
      CREATE INDEX sessions_project_idx
        ON agent_recall.sessions (project_path);
      CREATE INDEX sessions_environment_source_idx
        ON agent_recall.sessions (environment_id, source);
      CREATE INDEX session_message_events_time_idx
        ON agent_recall.session_message_events (occurred_at);
      CREATE INDEX session_turns_session_idx
        ON agent_recall.session_turns (session_key, turn_index);
      CREATE INDEX session_turns_started_idx
        ON agent_recall.session_turns (started_at DESC);
      CREATE INDEX session_turns_search_vector_idx
        ON agent_recall.session_turns USING gin (search_vector);
      CREATE INDEX session_turns_search_text_trgm_idx
        ON agent_recall.session_turns USING gin (search_text gin_trgm_ops);
      CREATE INDEX turn_messages_source_idx
        ON agent_recall.turn_messages (turn_id, source_message_index);
      CREATE INDEX trace_spans_parent_idx
        ON agent_recall.trace_spans (parent_span_id, span_index);
      CREATE INDEX trace_spans_turn_idx
        ON agent_recall.trace_spans (turn_id, span_index);
      CREATE INDEX token_events_time_idx
        ON agent_recall.token_events (occurred_at);
      CREATE INDEX skill_usage_events_skill_idx
        ON agent_recall.skill_usage_events (agent, skill, occurred_at);
      CREATE UNIQUE INDEX skill_sync_portable_identity_idx
        ON agent_recall.skill_sync_bindings (portable_identity)
        WHERE portable_identity <> '';
      CREATE INDEX session_migrations_source_idx
        ON agent_recall.session_migrations (source_session_key, created_at DESC, id DESC);
    `,
    `
      CREATE TABLE agent_recall.app_settings (
        key text PRIMARY KEY,
        value_text text,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.app_aux_state (
        id integer PRIMARY KEY CHECK (id = 1),
        payload jsonb NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.saved_searches (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL UNIQUE,
        options jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        last_used_at timestamptz,
        use_count integer NOT NULL DEFAULT 0
      );

      CREATE TABLE agent_recall.search_history (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        query text NOT NULL,
        result_count integer NOT NULL DEFAULT 0,
        searched_at timestamptz NOT NULL,
        options jsonb
      );

      CREATE INDEX search_history_time_idx
        ON agent_recall.search_history (searched_at DESC, id DESC);

      CREATE TABLE agent_recall.automation_chats (
        id text PRIMARY KEY,
        title text NOT NULL,
        configured_agent_id text NOT NULL,
        model_id text,
        channel_id text,
        last_error text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.automation_chat_messages (
        id text PRIMARY KEY,
        chat_id text NOT NULL REFERENCES agent_recall.automation_chats(id) ON DELETE CASCADE,
        role text NOT NULL,
        content text NOT NULL,
        is_local boolean NOT NULL DEFAULT false,
        sequence integer NOT NULL,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.automation_chat_events (
        id text PRIMARY KEY,
        chat_id text NOT NULL REFERENCES agent_recall.automation_chats(id) ON DELETE CASCADE,
        message_id text NOT NULL REFERENCES agent_recall.automation_chat_messages(id) ON DELETE CASCADE,
        type text NOT NULL,
        content text NOT NULL,
        agent_id text,
        name text,
        from_agent_id text,
        to_agent_id text,
        request_id text,
        request_state text,
        decision text,
        metadata jsonb,
        sequence integer NOT NULL,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.runtime_sessions (
        id text PRIMARY KEY,
        chat_id text NOT NULL REFERENCES agent_recall.automation_chats(id) ON DELETE CASCADE,
        runtime_id text,
        state text,
        provider_session_id text,
        runtime_state jsonb,
        conversation jsonb,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.workflows (
        id text PRIMARY KEY,
        title text NOT NULL,
        status text NOT NULL,
        revision integer NOT NULL,
        configured_agent_id text NOT NULL,
        model_id text NOT NULL,
        objective text NOT NULL,
        work_dir text,
        reply text NOT NULL,
        error text,
        run_context_document text NOT NULL,
        context_document text NOT NULL,
        final_report text,
        runtime_conversation jsonb,
        definition jsonb,
        workflow_v2_plan jsonb,
        source_type text NOT NULL DEFAULT 'user',
        topology_locked boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.workflow_draft_messages (
        id text PRIMARY KEY,
        workflow_id text NOT NULL REFERENCES agent_recall.workflows(id) ON DELETE CASCADE,
        role text NOT NULL,
        content text NOT NULL,
        events jsonb,
        sequence integer NOT NULL
      );

      CREATE TABLE agent_recall.workflow_run_progress (
        workflow_id text NOT NULL REFERENCES agent_recall.workflows(id) ON DELETE CASCADE,
        node_id text NOT NULL,
        title text NOT NULL,
        status text NOT NULL,
        detail text,
        task_id text,
        input_request jsonb,
        input_summary jsonb,
        intervention jsonb,
        messages jsonb,
        outputs jsonb,
        telemetry jsonb,
        sequence integer NOT NULL,
        PRIMARY KEY (workflow_id, node_id)
      );

      CREATE TABLE agent_recall.workflow_runs (
        id text PRIMARY KEY,
        workflow_id text NOT NULL REFERENCES agent_recall.workflows(id) ON DELETE CASCADE,
        workflow_v2_plan jsonb,
        status text NOT NULL,
        trigger_source text NOT NULL DEFAULT 'manual',
        configuration_snapshot jsonb,
        context_document text NOT NULL,
        final_report text,
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        last_error text
      );

      CREATE TABLE agent_recall.workflow_run_order (
        workflow_id text NOT NULL REFERENCES agent_recall.workflows(id) ON DELETE CASCADE,
        run_id text NOT NULL REFERENCES agent_recall.workflow_runs(id) ON DELETE CASCADE,
        sequence integer NOT NULL,
        PRIMARY KEY (workflow_id, run_id)
      );

      CREATE TABLE agent_recall.workflow_run_nodes (
        run_id text NOT NULL REFERENCES agent_recall.workflow_runs(id) ON DELETE CASCADE,
        node_id text NOT NULL,
        title text NOT NULL,
        status text NOT NULL,
        detail text,
        task_id text,
        input_request jsonb,
        input_summary jsonb,
        intervention jsonb,
        messages jsonb,
        outputs jsonb,
        telemetry jsonb,
        sequence integer NOT NULL,
        PRIMARY KEY (run_id, node_id)
      );

      CREATE TABLE agent_recall.workflow_events (
        id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES agent_recall.workflow_runs(id) ON DELETE CASCADE,
        node_id text NOT NULL,
        type text NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempt integer,
        task_id text,
        detail text,
        pass boolean,
        summary text,
        error text,
        question text,
        answer text,
        sequence integer NOT NULL
      );

      CREATE TABLE agent_recall.workflow_event_artifacts (
        event_id text NOT NULL REFERENCES agent_recall.workflow_events(id) ON DELETE CASCADE,
        sequence integer NOT NULL,
        kind text NOT NULL,
        title text NOT NULL,
        content text,
        path text,
        url text,
        PRIMARY KEY (event_id, sequence)
      );

      CREATE INDEX automation_chat_messages_order_idx
        ON agent_recall.automation_chat_messages (chat_id, sequence);
      CREATE INDEX automation_chat_events_order_idx
        ON agent_recall.automation_chat_events (message_id, sequence);
      CREATE INDEX runtime_sessions_chat_idx
        ON agent_recall.runtime_sessions (chat_id);
      CREATE INDEX workflow_runs_workflow_time_idx
        ON agent_recall.workflow_runs (workflow_id, started_at DESC);
      CREATE INDEX workflow_events_run_order_idx
        ON agent_recall.workflow_events (run_id, sequence);
    `,
    `
      CREATE TABLE agent_recall.mcp_servers (
        id text PRIMARY KEY,
        name text NOT NULL,
        transport text NOT NULL,
        command text,
        args jsonb NOT NULL,
        url text,
        env jsonb NOT NULL,
        headers jsonb NOT NULL DEFAULT '{}'::jsonb,
        enabled boolean NOT NULL DEFAULT true,
        disabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
        status text NOT NULL DEFAULT 'untested',
        last_error text,
        last_tested_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.mcp_tools (
        server_id text NOT NULL REFERENCES agent_recall.mcp_servers(id) ON DELETE CASCADE,
        name text NOT NULL,
        description text,
        input_schema jsonb NOT NULL,
        sequence integer NOT NULL,
        PRIMARY KEY (server_id, name)
      );
    `,
    `
      CREATE TABLE agent_recall.evaluation_datasets (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.evaluation_dataset_items (
        id text PRIMARY KEY,
        dataset_id text NOT NULL REFERENCES agent_recall.evaluation_datasets(id) ON DELETE CASCADE,
        input text NOT NULL,
        expected_output text,
        metadata jsonb NOT NULL,
        sequence integer NOT NULL
      );

      CREATE TABLE agent_recall.evaluation_evaluators (
        id text PRIMARY KEY,
        name text NOT NULL,
        kind text NOT NULL,
        prompt text,
        agent_id text,
        runtime_id text,
        threshold double precision NOT NULL,
        enabled boolean NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.evaluation_experiments (
        id text PRIMARY KEY,
        name text NOT NULL,
        dataset_id text NOT NULL REFERENCES agent_recall.evaluation_datasets(id),
        agent_id text NOT NULL,
        repetitions integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.evaluation_experiment_evaluators (
        experiment_id text NOT NULL REFERENCES agent_recall.evaluation_experiments(id) ON DELETE CASCADE,
        evaluator_id text NOT NULL REFERENCES agent_recall.evaluation_evaluators(id),
        sequence integer NOT NULL,
        PRIMARY KEY (experiment_id, evaluator_id)
      );

      CREATE TABLE agent_recall.evaluation_runs (
        id text PRIMARY KEY,
        experiment_id text NOT NULL REFERENCES agent_recall.evaluation_experiments(id) ON DELETE CASCADE,
        status text NOT NULL,
        agent_revision_id text,
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        average_score double precision,
        minimum_score double precision,
        pass_rate double precision,
        total_duration_ms bigint,
        error text
      );

      CREATE TABLE agent_recall.evaluation_case_results (
        id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES agent_recall.evaluation_runs(id) ON DELETE CASCADE,
        dataset_item_id text NOT NULL,
        repetition integer NOT NULL,
        input text NOT NULL,
        expected_output text,
        output text NOT NULL,
        error text,
        duration_ms bigint NOT NULL
      );

      CREATE TABLE agent_recall.evaluation_scores (
        case_result_id text NOT NULL REFERENCES agent_recall.evaluation_case_results(id) ON DELETE CASCADE,
        evaluator_id text NOT NULL,
        score double precision NOT NULL,
        passed boolean NOT NULL,
        reason text,
        evidence jsonb,
        failed_criteria jsonb,
        duration_ms bigint NOT NULL,
        token_count bigint,
        estimated_cost double precision,
        PRIMARY KEY (case_result_id, evaluator_id)
      );

      CREATE TABLE agent_recall.evaluation_subjects (
        id text PRIMARY KEY,
        subject_type text NOT NULL CHECK (subject_type IN ('session', 'turn', 'span')),
        session_key text REFERENCES agent_recall.sessions(session_key) ON DELETE CASCADE,
        turn_id text REFERENCES agent_recall.session_turns(id) ON DELETE CASCADE,
        span_id text REFERENCES agent_recall.trace_spans(id) ON DELETE CASCADE,
        CHECK (
          (subject_type = 'session' AND session_key IS NOT NULL AND turn_id IS NULL AND span_id IS NULL) OR
          (subject_type = 'turn' AND session_key IS NULL AND turn_id IS NOT NULL AND span_id IS NULL) OR
          (subject_type = 'span' AND session_key IS NULL AND turn_id IS NULL AND span_id IS NOT NULL)
        )
      );

      CREATE TABLE agent_recall.evaluation_results (
        id text PRIMARY KEY,
        subject_id text NOT NULL REFERENCES agent_recall.evaluation_subjects(id) ON DELETE CASCADE,
        evaluator_id text,
        metric text NOT NULL,
        score double precision,
        label text,
        passed boolean,
        explanation text,
        evidence jsonb,
        evaluator_version text,
        created_at timestamptz NOT NULL
      );

      CREATE INDEX evaluation_dataset_items_order_idx
        ON agent_recall.evaluation_dataset_items (dataset_id, sequence);
      CREATE INDEX evaluation_runs_started_idx
        ON agent_recall.evaluation_runs (started_at DESC);
      CREATE INDEX evaluation_runs_experiment_started_idx
        ON agent_recall.evaluation_runs (experiment_id, started_at DESC);
      CREATE INDEX evaluation_case_results_run_idx
        ON agent_recall.evaluation_case_results (run_id);
      CREATE UNIQUE INDEX evaluation_subject_session_idx
        ON agent_recall.evaluation_subjects (session_key)
        WHERE subject_type = 'session';
      CREATE UNIQUE INDEX evaluation_subject_turn_idx
        ON agent_recall.evaluation_subjects (turn_id)
        WHERE subject_type = 'turn';
      CREATE UNIQUE INDEX evaluation_subject_span_idx
        ON agent_recall.evaluation_subjects (span_id)
        WHERE subject_type = 'span';
      CREATE INDEX evaluation_results_subject_idx
        ON agent_recall.evaluation_results (subject_id, created_at DESC);
    `,
    `
      CREATE TABLE agent_recall.chat_rooms (
        id uuid PRIMARY KEY,
        name varchar(120) NOT NULL,
        work_dir text NOT NULL DEFAULT '',
        archived boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.chat_room_agents (
        room_id uuid NOT NULL REFERENCES agent_recall.chat_rooms(id) ON DELETE CASCADE,
        agent_id text NOT NULL,
        display_name varchar(120) NOT NULL,
        runtime_id varchar(80) NOT NULL,
        channel_id varchar(160) NOT NULL,
        model_id varchar(240) NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        position integer NOT NULL,
        joined_at timestamptz NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );

      CREATE TABLE agent_recall.chat_messages (
        id uuid PRIMARY KEY,
        room_id uuid NOT NULL REFERENCES agent_recall.chat_rooms(id) ON DELETE CASCADE,
        sender_type varchar(16) NOT NULL CHECK (sender_type IN ('human', 'agent', 'system')),
        sender_agent_id text,
        sender_name varchar(120) NOT NULL,
        content text NOT NULL,
        root_message_id uuid NOT NULL,
        source_message_id uuid,
        hop integer NOT NULL DEFAULT 0,
        status varchar(16) NOT NULL CHECK (status IN ('final', 'error')),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.chat_agent_sessions (
        room_id uuid NOT NULL REFERENCES agent_recall.chat_rooms(id) ON DELETE CASCADE,
        agent_id text NOT NULL,
        runtime_id varchar(80) NOT NULL,
        channel_id varchar(160) NOT NULL,
        model_id varchar(240) NOT NULL,
        runtime_conversation jsonb NOT NULL,
        last_context_message_id uuid REFERENCES agent_recall.chat_messages(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );

      CREATE TABLE agent_recall.chat_dispatches (
        id uuid PRIMARY KEY,
        room_id uuid NOT NULL REFERENCES agent_recall.chat_rooms(id) ON DELETE CASCADE,
        root_message_id uuid NOT NULL,
        source_message_id uuid NOT NULL,
        target_agent_id text NOT NULL,
        hop integer NOT NULL,
        status varchar(20) NOT NULL CHECK (
          status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'skipped')
        ),
        error text,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE INDEX chat_rooms_updated_idx
        ON agent_recall.chat_rooms (archived, updated_at DESC);
      CREATE INDEX chat_messages_room_page_idx
        ON agent_recall.chat_messages (room_id, created_at DESC, id DESC);
      CREATE INDEX chat_dispatches_root_idx
        ON agent_recall.chat_dispatches (root_message_id, created_at);
    `,
    `
      INSERT INTO agent_recall.environments (
        id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
      )
      VALUES ('local', 'local', 'Local', 'none', true, 'idle', now(), now())
      ON CONFLICT (id) DO NOTHING
    `,
  ],
}, {
  version: 2,
  name: "add discovery, WSL, and Workflow run telemetry",
  statements: [
    `
      ALTER TABLE agent_recall.environments
        ADD COLUMN IF NOT EXISTS wsl_distribution text;

      ALTER TABLE agent_recall.workflow_runs
        ADD COLUMN IF NOT EXISTS trigger_source text NOT NULL DEFAULT 'manual';
      ALTER TABLE agent_recall.workflow_runs
        ADD COLUMN IF NOT EXISTS configuration_snapshot jsonb;

      ALTER TABLE agent_recall.workflow_run_progress
        ADD COLUMN IF NOT EXISTS input_summary jsonb;
      ALTER TABLE agent_recall.workflow_run_progress
        ADD COLUMN IF NOT EXISTS outputs jsonb;
      ALTER TABLE agent_recall.workflow_run_progress
        ADD COLUMN IF NOT EXISTS telemetry jsonb;

      ALTER TABLE agent_recall.workflow_run_nodes
        ADD COLUMN IF NOT EXISTS input_summary jsonb;
      ALTER TABLE agent_recall.workflow_run_nodes
        ADD COLUMN IF NOT EXISTS outputs jsonb;
      ALTER TABLE agent_recall.workflow_run_nodes
        ADD COLUMN IF NOT EXISTS telemetry jsonb;

      CREATE TABLE IF NOT EXISTS agent_recall.saved_searches (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL UNIQUE,
        options jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        last_used_at timestamptz,
        use_count integer NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS agent_recall.search_history (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        query text NOT NULL,
        result_count integer NOT NULL DEFAULT 0,
        searched_at timestamptz NOT NULL,
        options jsonb
      );

      CREATE INDEX IF NOT EXISTS search_history_time_idx
        ON agent_recall.search_history (searched_at DESC, id DESC);
    `,
  ],
}, {
  version: 3,
  name: "limit Session search to conversation messages",
  statements: [
    `
      UPDATE agent_recall.session_turns
      SET
        search_text = concat_ws(
          E'\n\n',
          nullif(user_text, ''),
          nullif(assistant_text, '')
        ),
        derivation_version = 2
      WHERE
        search_text IS DISTINCT FROM concat_ws(
          E'\n\n',
          nullif(user_text, ''),
          nullif(assistant_text, '')
        )
        OR derivation_version < 2;
    `,
  ],
}, {
  version: 4,
  name: "persist Workflow draft message events",
  statements: [
    `
      ALTER TABLE agent_recall.workflow_draft_messages
        ADD COLUMN IF NOT EXISTS events jsonb;
    `,
  ],
}, {
  version: 5,
  name: "add directory-scoped OpenViking memory state",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS agent_recall.openviking_workspaces (
        id text PRIMARY KEY,
        user_id text NOT NULL UNIQUE,
        root_path text NOT NULL UNIQUE,
        identity text NOT NULL UNIQUE,
        display_name text NOT NULL,
        managed boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_import_jobs (
        workspace_id text PRIMARY KEY
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        state text NOT NULL DEFAULT 'idle'
          CHECK (state IN ('idle', 'queued', 'running', 'paused', 'failed', 'completed')),
        imported_turns integer NOT NULL DEFAULT 0 CHECK (imported_turns >= 0),
        total_turns integer NOT NULL DEFAULT 0 CHECK (total_turns >= 0),
        cursor_session_key text,
        last_error text,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_imported_turns (
        workspace_id text NOT NULL
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        source_turn_id text NOT NULL,
        fingerprint text NOT NULL,
        imported_at timestamptz NOT NULL,
        PRIMARY KEY (workspace_id, source_turn_id, fingerprint)
      );

      CREATE INDEX IF NOT EXISTS openviking_workspaces_managed_idx
        ON agent_recall.openviking_workspaces (managed, updated_at DESC);
      CREATE INDEX IF NOT EXISTS openviking_imported_turns_workspace_idx
        ON agent_recall.openviking_imported_turns (workspace_id, imported_at);
    `,
  ],
}, {
  version: 6,
  name: "reconcile memory, Workflow events, and studio collaboration",
  statements: [
    `
      ALTER TABLE agent_recall.workflow_draft_messages
        ADD COLUMN IF NOT EXISTS events jsonb;

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_workspaces (
        id text PRIMARY KEY,
        user_id text NOT NULL UNIQUE,
        root_path text NOT NULL UNIQUE,
        identity text NOT NULL UNIQUE,
        display_name text NOT NULL,
        managed boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_import_jobs (
        workspace_id text PRIMARY KEY
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        state text NOT NULL DEFAULT 'idle'
          CHECK (state IN ('idle', 'queued', 'running', 'paused', 'failed', 'completed')),
        imported_turns integer NOT NULL DEFAULT 0 CHECK (imported_turns >= 0),
        total_turns integer NOT NULL DEFAULT 0 CHECK (total_turns >= 0),
        cursor_session_key text,
        last_error text,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_imported_turns (
        workspace_id text NOT NULL
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        source_turn_id text NOT NULL,
        fingerprint text NOT NULL,
        imported_at timestamptz NOT NULL,
        PRIMARY KEY (workspace_id, source_turn_id, fingerprint)
      );

      CREATE INDEX IF NOT EXISTS openviking_workspaces_managed_idx
        ON agent_recall.openviking_workspaces (managed, updated_at DESC);
      CREATE INDEX IF NOT EXISTS openviking_imported_turns_workspace_idx
        ON agent_recall.openviking_imported_turns (workspace_id, imported_at);

      ALTER TABLE agent_recall.chat_room_agents
        ADD COLUMN IF NOT EXISTS configured_agent_id text;

      UPDATE agent_recall.chat_room_agents
      SET configured_agent_id = agent_id
      WHERE configured_agent_id IS NULL;

      ALTER TABLE agent_recall.chat_room_agents
        ALTER COLUMN configured_agent_id SET NOT NULL;

      ALTER TABLE agent_recall.chat_messages
        ADD COLUMN IF NOT EXISTS recipient_member_id text,
        ADD COLUMN IF NOT EXISTS delivery_type varchar(16) NOT NULL DEFAULT 'message'
          CHECK (delivery_type IN ('message', 'reply', 'post')),
        ADD COLUMN IF NOT EXISTS sequence bigint;

      WITH ranked AS (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY room_id
            ORDER BY created_at, id
          ) AS sequence
        FROM agent_recall.chat_messages
      )
      UPDATE agent_recall.chat_messages AS messages
      SET sequence = ranked.sequence
      FROM ranked
      WHERE messages.id = ranked.id;

      ALTER TABLE agent_recall.chat_messages
        ALTER COLUMN sequence SET NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_room_sequence_idx
        ON agent_recall.chat_messages (room_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_recall.chat_workspace_reservations (
        room_id uuid NOT NULL REFERENCES agent_recall.chat_rooms(id) ON DELETE CASCADE,
        member_id text NOT NULL,
        relative_path text NOT NULL,
        reason text,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (room_id, relative_path)
      );

      CREATE INDEX IF NOT EXISTS chat_workspace_reservations_expiry_idx
        ON agent_recall.chat_workspace_reservations (expires_at);
    `,
  ],
}, {
  version: 7,
  name: "cache safe session attachments",
  statements: [
    `
      CREATE TABLE agent_recall.session_attachments (
        session_key text NOT NULL
          REFERENCES agent_recall.sessions(session_key) ON DELETE CASCADE,
        attachment_id text NOT NULL,
        message_index integer NOT NULL,
        file_name text NOT NULL,
        mime_type text NOT NULL,
        preview_kind text NOT NULL,
        status text NOT NULL,
        size_bytes bigint,
        cache_path text,
        PRIMARY KEY (session_key, attachment_id)
      );

      CREATE INDEX session_attachments_message_idx
        ON agent_recall.session_attachments (session_key, message_index);
    `,
  ],
}, {
  version: 8,
  name: "track Session storage separately from execution",
  statements: [
    `
      ALTER TABLE agent_recall.sessions
        ADD COLUMN IF NOT EXISTS storage_environment_id text DEFAULT 'local';

      UPDATE agent_recall.sessions
      SET storage_environment_id = environment_id;

      ALTER TABLE agent_recall.sessions
        ALTER COLUMN storage_environment_id SET NOT NULL;
    `,
  ],
}, {
  version: 9,
  name: "track full Session content freshness",
  statements: [
    `
      ALTER TABLE agent_recall.sessions
        ADD COLUMN IF NOT EXISTS content_indexed_mtime_ms double precision NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS content_indexed_size bigint NOT NULL DEFAULT 0;
    `,
  ],
}, {
  version: 10,
  name: "persist Studio room Runtime Turns",
  statements: [
    `
      ALTER TABLE agent_recall.chat_agent_sessions
        ADD COLUMN IF NOT EXISTS room_context_sequence bigint NOT NULL DEFAULT 0;

      UPDATE agent_recall.chat_agent_sessions AS sessions
      SET room_context_sequence = messages.sequence
      FROM agent_recall.chat_messages AS messages
      WHERE sessions.last_context_message_id = messages.id
        AND sessions.room_id = messages.room_id
        AND sessions.room_context_sequence = 0;

      ALTER TABLE agent_recall.chat_messages
        ADD COLUMN IF NOT EXISTS based_on_sequence bigint;

      CREATE TABLE IF NOT EXISTS agent_recall.chat_message_mentions (
        id uuid PRIMARY KEY,
        room_id uuid NOT NULL REFERENCES agent_recall.chat_rooms(id) ON DELETE CASCADE,
        message_id uuid NOT NULL REFERENCES agent_recall.chat_messages(id) ON DELETE CASCADE,
        member_id text NOT NULL,
        created_at timestamptz NOT NULL,
        UNIQUE (message_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS agent_recall.chat_tasks (
        id uuid PRIMARY KEY,
        room_id uuid NOT NULL REFERENCES agent_recall.chat_rooms(id) ON DELETE CASCADE,
        member_id text NOT NULL,
        root_message_id uuid NOT NULL REFERENCES agent_recall.chat_messages(id) ON DELETE CASCADE,
        status varchar(24) NOT NULL
          CHECK (status IN ('in_progress', 'completed', 'blocked', 'waiting_input')),
        summary text,
        evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        finished_at timestamptz
      );

      ALTER TABLE agent_recall.chat_dispatches
        ADD COLUMN IF NOT EXISTS mention_id uuid
          REFERENCES agent_recall.chat_message_mentions(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS task_id uuid
          REFERENCES agent_recall.chat_tasks(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS room_snapshot_sequence bigint;

      CREATE UNIQUE INDEX IF NOT EXISTS chat_dispatches_mention_idx
        ON agent_recall.chat_dispatches (mention_id)
        WHERE mention_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS chat_dispatches_member_queue_idx
        ON agent_recall.chat_dispatches
          (room_id, target_agent_id, status, room_snapshot_sequence, created_at);

      CREATE INDEX IF NOT EXISTS chat_tasks_room_member_idx
        ON agent_recall.chat_tasks (room_id, member_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_recall.chat_dispatch_attempts (
        id uuid PRIMARY KEY,
        dispatch_id uuid NOT NULL
          REFERENCES agent_recall.chat_dispatches(id) ON DELETE CASCADE,
        attempt_number integer NOT NULL CHECK (attempt_number > 0),
        runtime_id varchar(80) NOT NULL,
        runtime_session_ref text,
        native_turn_id text,
        room_snapshot_sequence bigint NOT NULL CHECK (room_snapshot_sequence >= 0),
        room_sequence_at_finish bigint,
        status varchar(16) NOT NULL
          CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
        error text,
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        UNIQUE (dispatch_id, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS agent_recall.chat_attempt_events (
        id uuid PRIMARY KEY,
        attempt_id uuid NOT NULL
          REFERENCES agent_recall.chat_dispatch_attempts(id) ON DELETE CASCADE,
        sequence integer NOT NULL CHECK (sequence > 0),
        type varchar(24) NOT NULL
          CHECK (type IN (
            'delta', 'tool_call', 'tool_result', 'approval_request',
            'approval_response', 'completed', 'error'
          )),
        name text,
        content text NOT NULL,
        created_at timestamptz NOT NULL,
        UNIQUE (attempt_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS chat_attempt_events_attempt_idx
        ON agent_recall.chat_attempt_events (attempt_id, sequence);
    `,
  ],
}, {
  version: 11,
  name: "retain unavailable Cursor Session caches",
  statements: [
    `
      ALTER TABLE agent_recall.sessions
        ADD COLUMN IF NOT EXISTS source_available boolean NOT NULL DEFAULT true;
    `,
  ],
}, {
  version: 12,
  name: "link skill usage events to indexed Sessions",
  statements: [
    `
      ALTER TABLE agent_recall.skill_usage_events
        ADD COLUMN IF NOT EXISTS session_id text,
        ADD COLUMN IF NOT EXISTS cwd text;

      CREATE INDEX IF NOT EXISTS skill_usage_events_session_idx
        ON agent_recall.skill_usage_events (session_id)
        WHERE session_id IS NOT NULL;
    `,
  ],
}, {
  version: 13,
  name: "persist Workflow portable origin and review metadata",
  statements: [
    `
      ALTER TABLE agent_recall.workflows
        ADD COLUMN IF NOT EXISTS origin jsonb,
        ADD COLUMN IF NOT EXISTS confirmed_revision integer,
        ADD COLUMN IF NOT EXISTS reviewer_configured_agent_id text,
        ADD COLUMN IF NOT EXISTS reviewer_model_id text,
        ADD COLUMN IF NOT EXISTS generation_review jsonb;
    `,
  ],
}, {
  version: 14,
  name: "track disabled MCP tools per server",
  statements: [
    `
      ALTER TABLE agent_recall.mcp_servers
        ADD COLUMN IF NOT EXISTS disabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  ],
}, {
  version: 15,
  name: "record the skill version hash on usage events",
  statements: [
    `
      ALTER TABLE agent_recall.skill_usage_events
        ADD COLUMN IF NOT EXISTS skill_hash text;
    `,
  ],
}, {
  version: 16,
  name: "persist Codex turn lifecycle metadata",
  statements: [
    `
      ALTER TABLE agent_recall.sessions
        ADD COLUMN IF NOT EXISTS codex_history_mode text;

      ALTER TABLE agent_recall.session_turns
        ADD COLUMN IF NOT EXISTS source_turn_id text,
        ADD COLUMN IF NOT EXISTS duration_ms bigint,
        ADD COLUMN IF NOT EXISTS time_to_first_token_ms bigint,
        ADD COLUMN IF NOT EXISTS abort_reason text;

      CREATE INDEX IF NOT EXISTS session_turns_source_turn_idx
        ON agent_recall.session_turns (session_key, source_turn_id)
      WHERE source_turn_id IS NOT NULL;
    `,
  ],
}, {
  version: 17,
  name: "refresh Codex and Claude session semantics",
  statements: [
    `
      ALTER TABLE agent_recall.token_events
        ADD COLUMN IF NOT EXISTS source_turn_id text;

      UPDATE agent_recall.sessions
      SET file_mtime_ms = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0
      WHERE source IN (
        'claude-cli', 'claude-app', 'tclaude-cli',
        'codex-cli', 'codex-app', 'tcodex-cli'
      );
    `,
  ],
}, {
  version: 18,
  name: "refresh Codex tool trace details",
  statements: [
    `
      UPDATE agent_recall.sessions
      SET file_mtime_ms = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0
      WHERE source IN ('codex-cli', 'codex-app', 'tcodex-cli');
    `,
  ],
}, {
  version: 19,
  name: "track incremental OpenViking Session imports",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS agent_recall.openviking_imported_sessions (
        workspace_id text NOT NULL
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        session_key text NOT NULL,
        source_revision text NOT NULL,
        imported_turns integer NOT NULL CHECK (imported_turns >= 0),
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (workspace_id, session_key)
      );

      CREATE INDEX IF NOT EXISTS openviking_imported_sessions_workspace_idx
        ON agent_recall.openviking_imported_sessions (workspace_id, updated_at DESC);
    `,
  ],
}, {
  version: 20,
  name: "persist resumable OpenViking import tasks",
  statements: [
    `
      ALTER TABLE agent_recall.openviking_import_jobs
        ADD COLUMN IF NOT EXISTS completed_tasks integer NOT NULL DEFAULT 0
          CHECK (completed_tasks >= 0),
        ADD COLUMN IF NOT EXISTS total_tasks integer NOT NULL DEFAULT 0
          CHECK (total_tasks >= 0);

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_import_tasks (
        id text PRIMARY KEY,
        workspace_id text NOT NULL
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        session_key text NOT NULL,
        source_revision text NOT NULL,
        session_title text NOT NULL,
        payload jsonb NOT NULL,
        state text NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued', 'uploading', 'waiting', 'completed', 'failed')),
        attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        remote_task_id text,
        last_error text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE INDEX IF NOT EXISTS openviking_import_tasks_workspace_state_idx
        ON agent_recall.openviking_import_tasks (workspace_id, state, created_at);
    `,
  ],
}, {
  version: 21,
  name: "preserve planned OpenViking import order",
  statements: [
    `
      ALTER TABLE agent_recall.openviking_import_tasks
        ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0
          CHECK (position >= 0);

      CREATE INDEX IF NOT EXISTS openviking_import_tasks_workspace_position_idx
        ON agent_recall.openviking_import_tasks (workspace_id, position);
    `,
  ],
}, {
  version: 22,
  name: "persist selected OpenViking import sessions",
  statements: [
    `
      ALTER TABLE agent_recall.openviking_import_jobs
        ADD COLUMN IF NOT EXISTS selected_session_keys jsonb;
    `,
  ],
}, {
  version: 23,
  name: "reconcile OpenViking and Codex migration histories",
  statements: [
    `
      ALTER TABLE agent_recall.sessions
        ADD COLUMN IF NOT EXISTS codex_history_mode text;

      ALTER TABLE agent_recall.session_turns
        ADD COLUMN IF NOT EXISTS source_turn_id text,
        ADD COLUMN IF NOT EXISTS duration_ms bigint,
        ADD COLUMN IF NOT EXISTS time_to_first_token_ms bigint,
        ADD COLUMN IF NOT EXISTS abort_reason text;

      CREATE INDEX IF NOT EXISTS session_turns_source_turn_idx
        ON agent_recall.session_turns (session_key, source_turn_id)
      WHERE source_turn_id IS NOT NULL;

      ALTER TABLE agent_recall.token_events
        ADD COLUMN IF NOT EXISTS source_turn_id text;
    `,
  ],
}, {
  version: 24,
  name: "store HTTP header references for MCP servers",
  statements: [
    `
      ALTER TABLE agent_recall.mcp_servers
        ADD COLUMN IF NOT EXISTS headers jsonb NOT NULL DEFAULT '{}'::jsonb;
    `,
  ],
}, {
  version: 25,
  name: "bind evaluation experiments to skill versions",
  statements: [
    `
      ALTER TABLE agent_recall.evaluation_experiments
        ADD COLUMN IF NOT EXISTS skill_name text,
        ADD COLUMN IF NOT EXISTS skill_hash text;

      CREATE INDEX IF NOT EXISTS evaluation_experiments_skill_idx
        ON agent_recall.evaluation_experiments (skill_name)
        WHERE skill_name IS NOT NULL;
    `,
  ],
}, {
  version: 26,
  name: "reindex sessions after stale Codex turn attribution fix",
  statements: [
    `
      UPDATE agent_recall.sessions
      SET
        content_indexed_mtime_ms = 0,
        content_indexed_size = 0
      WHERE EXISTS (
        SELECT 1
        FROM agent_recall.session_turns turns
        WHERE turns.session_key = sessions.session_key
          AND turns.derivation_version < 4
      );
    `,
  ],
}, {
  version: 27,
  name: "attribute evaluation runs to the skill version that executed them",
  statements: [
    `
      ALTER TABLE agent_recall.evaluation_runs
        ADD COLUMN IF NOT EXISTS skill_hash text;
    `,
  ],
}, {
  version: 28,
  name: "add directory memory control plane",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS agent_recall.openviking_memories (
        workspace_id text NOT NULL
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        uri text NOT NULL,
        memory_type text NOT NULL,
        authority text NOT NULL DEFAULT 'model'
          CHECK (authority IN ('model', 'user')),
        lifecycle text NOT NULL DEFAULT 'active'
          CHECK (lifecycle IN ('active', 'disputed', 'superseded', 'invalidated', 'deleted')),
        locked boolean NOT NULL DEFAULT false,
        evidence_status text NOT NULL DEFAULT 'legacy'
          CHECK (evidence_status IN ('verified', 'legacy', 'invalid')),
        source text NOT NULL DEFAULT 'legacy'
          CHECK (source IN ('openviking', 'manual', 'user-edit', 'legacy')),
        title text,
        locked_content text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (workspace_id, uri)
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_memory_evidence (
        id text PRIMARY KEY,
        workspace_id text NOT NULL,
        memory_uri text NOT NULL,
        source_session_id text,
        source_agent text,
        source_turn_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        archive_uri text,
        memory_diff_uri text,
        remote_task_id text,
        model_snapshot jsonb,
        policy_snapshot jsonb,
        state text NOT NULL DEFAULT 'active'
          CHECK (state IN ('active', 'invalidated')),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        FOREIGN KEY (workspace_id, memory_uri)
          REFERENCES agent_recall.openviking_memories(workspace_id, uri) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_memory_feedback (
        id text PRIMARY KEY,
        workspace_id text NOT NULL,
        memory_uri text NOT NULL,
        feedback text NOT NULL CHECK (feedback IN ('helpful', 'wrong', 'outdated')),
        actor text NOT NULL,
        note text,
        created_at timestamptz NOT NULL,
        FOREIGN KEY (workspace_id, memory_uri)
          REFERENCES agent_recall.openviking_memories(workspace_id, uri) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_commit_runs (
        task_id text PRIMARY KEY,
        workspace_id text NOT NULL
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        session_id text NOT NULL,
        agent text,
        trigger text NOT NULL,
        state text NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
        source_turn_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        token_estimate integer NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
        archive_uri text,
        memory_diff_uri text,
        memories_extracted jsonb,
        token_usage jsonb,
        error text,
        started_at timestamptz NOT NULL,
        completed_at timestamptz,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_operation_events (
        id text PRIMARY KEY,
        workspace_id text NOT NULL
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        phase text NOT NULL,
        status text NOT NULL
          CHECK (status IN ('started', 'completed', 'failed', 'degraded', 'skipped')),
        session_id text,
        task_id text,
        started_at timestamptz NOT NULL,
        completed_at timestamptz,
        duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
        details jsonb
      );

      CREATE TABLE IF NOT EXISTS agent_recall.openviking_recall_traces (
        id text PRIMARY KEY,
        workspace_id text NOT NULL
          REFERENCES agent_recall.openviking_workspaces(id) ON DELETE CASCADE,
        agent text NOT NULL,
        query text NOT NULL,
        contextual_query text NOT NULL,
        searched_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
        searched_types jsonb NOT NULL DEFAULT '[]'::jsonb,
        candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
        injected_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
        injected_token_count integer NOT NULL DEFAULT 0 CHECK (injected_token_count >= 0),
        duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        degraded_reason text,
        created_at timestamptz NOT NULL
      );

      CREATE INDEX IF NOT EXISTS openviking_memories_recall_idx
        ON agent_recall.openviking_memories (
          workspace_id, lifecycle, evidence_status, locked, updated_at DESC
        );
      CREATE INDEX IF NOT EXISTS openviking_memory_evidence_uri_idx
        ON agent_recall.openviking_memory_evidence (workspace_id, memory_uri, created_at DESC);
      CREATE INDEX IF NOT EXISTS openviking_memory_feedback_uri_idx
        ON agent_recall.openviking_memory_feedback (workspace_id, memory_uri, created_at DESC);
      CREATE INDEX IF NOT EXISTS openviking_commit_runs_workspace_idx
        ON agent_recall.openviking_commit_runs (workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS openviking_operation_events_workspace_idx
        ON agent_recall.openviking_operation_events (workspace_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS openviking_recall_traces_workspace_idx
        ON agent_recall.openviking_recall_traces (workspace_id, created_at DESC);
    `,
  ],
}, {
  version: 29,
  name: "reconcile directory memory and evaluation migration histories",
  statements: [
    `
      ALTER TABLE agent_recall.evaluation_runs
        ADD COLUMN IF NOT EXISTS skill_hash text;
    `,
  ],
}, {
  version: 30,
  name: "persist Workflow review history and full-rerun lineage",
  statements: [
    `
      ALTER TABLE agent_recall.workflow_runs
        ADD COLUMN IF NOT EXISTS parent_run_id text;
      ALTER TABLE agent_recall.workflow_run_progress
        ADD COLUMN IF NOT EXISTS review_history jsonb;
      ALTER TABLE agent_recall.workflow_run_nodes
        ADD COLUMN IF NOT EXISTS review_history jsonb;
    `,
  ],
}, {
  version: 31,
  name: "persist MCP tool read-only declarations",
  statements: [
    `
      ALTER TABLE agent_recall.mcp_tools
        ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false;
    `,
  ],
}, {
  version: 32,
  name: "separate cache creation tokens from cache reads",
  statements: [
    `
      ALTER TABLE agent_recall.sessions
        ADD COLUMN IF NOT EXISTS cache_creation_input_tokens bigint NOT NULL DEFAULT 0;
      ALTER TABLE agent_recall.session_turns
        ADD COLUMN IF NOT EXISTS cache_creation_input_tokens bigint NOT NULL DEFAULT 0;
      ALTER TABLE agent_recall.token_events
        ADD COLUMN IF NOT EXISTS cache_creation_input_tokens bigint NOT NULL DEFAULT 0;

      UPDATE agent_recall.sessions
      SET file_mtime_ms = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0
      WHERE source IN ('claude-cli', 'claude-app', 'tclaude-cli', 'zcode-cli');
    `,
  ],
}, {
  version: 33,
  name: "replace Workflow V2 storage with structured Workflow storage",
  statements: [
    `
      DROP TABLE IF EXISTS agent_recall.workflow_event_artifacts;
      DROP TABLE IF EXISTS agent_recall.workflow_events;
      DROP TABLE IF EXISTS agent_recall.workflow_run_nodes;
      DROP TABLE IF EXISTS agent_recall.workflow_run_order;
      DROP TABLE IF EXISTS agent_recall.workflow_run_progress;
      DROP TABLE IF EXISTS agent_recall.workflow_draft_messages;
      DROP TABLE IF EXISTS agent_recall.workflow_runs;
      DROP TABLE IF EXISTS agent_recall.workflows;

      CREATE TABLE agent_recall.workflows (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text NOT NULL,
        definition jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE agent_recall.workflow_runs (
        id text PRIMARY KEY,
        workflow_id text NOT NULL REFERENCES agent_recall.workflows(id) ON DELETE CASCADE,
        definition jsonb NOT NULL,
        inputs jsonb NOT NULL,
        status text NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz
      );

      CREATE TABLE agent_recall.workflow_node_runs (
        run_id text NOT NULL REFERENCES agent_recall.workflow_runs(id) ON DELETE CASCADE,
        node_id text NOT NULL,
        status text NOT NULL,
        attempt integer NOT NULL CHECK (attempt >= 0),
        resolved_inputs jsonb,
        revision_feedback jsonb,
        outputs jsonb,
        error jsonb,
        started_at timestamptz,
        finished_at timestamptz,
        PRIMARY KEY (run_id, node_id)
      );

      CREATE TABLE agent_recall.workflow_artifacts (
        id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES agent_recall.workflow_runs(id) ON DELETE CASCADE,
        node_id text NOT NULL,
        field_key text NOT NULL,
        path text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL
      );

      CREATE INDEX workflow_runs_workflow_started_idx
        ON agent_recall.workflow_runs (workflow_id, started_at DESC);
      CREATE INDEX workflow_artifacts_run_idx
        ON agent_recall.workflow_artifacts (run_id, node_id);
    `,
  ],
}, {
  version: 34,
  name: "record structured Workflow run lifecycle events",
  statements: [
    `
      ALTER TABLE agent_recall.workflow_runs
        ADD COLUMN IF NOT EXISTS events jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  ],
}, {
  version: 35,
  name: "preserve Cursor custom title precedence",
  statements: [],
}, {
  version: 36,
  name: "store AI summary freshness timestamps without integer overflow",
  statements: [
    `
      ALTER TABLE agent_recall.sessions
        ALTER COLUMN ai_summary_basis TYPE double precision
        USING ai_summary_basis::double precision;
    `,
  ],
}, {
  version: 37,
  name: "reindex sessions containing injected user-role notifications",
  statements: [
    `
      UPDATE agent_recall.sessions sessions
      SET file_mtime_ms = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0
      WHERE EXISTS (
        SELECT 1
        FROM agent_recall.session_turns turns
        JOIN agent_recall.turn_messages messages ON messages.turn_id = turns.id
        WHERE turns.session_key = sessions.session_key
          AND messages.role = 'user'
          AND (
            strpos(lower(messages.content), '<subagent_notification') > 0
            OR strpos(lower(messages.content), '<task-notification') > 0
            OR strpos(lower(messages.content), '<system_notification') > 0
            OR lower(ltrim(messages.content)) LIKE
              'perform any necessary follow-up actions in response to the subagent completion above.%'
          )
      );
    `,
  ],
}, {
  version: 38,
  name: "reindex Codex subagent Turn boundaries",
  statements: [
    `
      UPDATE agent_recall.sessions
      SET file_mtime_ms = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0
      WHERE is_subagent = true
        AND source IN ('codex-cli', 'codex-app', 'tcodex-cli');
    `,
  ],
}, {
  version: 39,
  name: "reindex Codex subagent lifecycle fallback boundaries",
  statements: [
    `
      UPDATE agent_recall.sessions
      SET file_mtime_ms = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0
      WHERE is_subagent = true
        AND source IN ('codex-cli', 'codex-app', 'tcodex-cli');
    `,
  ],
}, {
  version: 40,
  name: "reindex DeepSeek token accounting",
  statements: [
    `
      UPDATE agent_recall.sessions
      SET file_mtime_ms = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0
      WHERE source = 'deepseek-cli';
    `,
  ],
}, {
  version: 41,
  name: "persist incremental Codex tool-call reconciliation state",
  statements: [
    `
      ALTER TABLE agent_recall.sessions
        ADD COLUMN IF NOT EXISTS codex_tool_call_state jsonb;

      UPDATE agent_recall.sessions
      SET file_mtime_ms = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0
      WHERE source IN ('codex-cli', 'codex-app', 'stepcode-codex', 'tcodex-cli');
    `,
  ],
}];
