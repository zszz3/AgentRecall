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
        ai_summary_basis integer
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
        started_at timestamptz,
        ended_at timestamptz,
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
        intervention jsonb,
        messages jsonb,
        sequence integer NOT NULL,
        PRIMARY KEY (workflow_id, node_id)
      );

      CREATE TABLE agent_recall.workflow_runs (
        id text PRIMARY KEY,
        workflow_id text NOT NULL REFERENCES agent_recall.workflows(id) ON DELETE CASCADE,
        workflow_v2_plan jsonb,
        status text NOT NULL,
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
        intervention jsonb,
        messages jsonb,
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
        enabled boolean NOT NULL DEFAULT true,
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
}];
