import type { SqliteMigration } from "./database";

/**
 * Unified AgentRecall 2.0 SQLite v1 schema.
 *
 * Includes all 48 active tables/views migrated from PostgreSQL migrations 1–65 (excluding
 * retired Workflow, OpenViking, and Studio chat-room tables), plus FTS5 `trigram` external-
 * content indexes for sessions, session turns, and memory cards with trigger synchronization.
 *
 * Conventions:
 * - Booleans are stored as INTEGER (0 / 1).
 * - Timestamps are stored as UTC epoch milliseconds (INTEGER).
 * - JSON payloads and string arrays are stored as TEXT.
 */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "create unified AgentRecall SQLite schema",
    statements: [
      `
        CREATE TABLE environments (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          wsl_distribution TEXT,
          host_alias TEXT,
          host TEXT,
          "user" TEXT,
          port INTEGER,
          auth_mode TEXT NOT NULL,
          identity_file TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          sync_state TEXT NOT NULL DEFAULT 'idle',
          last_synced_at INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        INSERT OR IGNORE INTO environments (
          id, kind, label, wsl_distribution, host_alias, host, "user", port,
          auth_mode, identity_file, enabled, sync_state, last_synced_at, last_error,
          created_at, updated_at
        )
        VALUES (
          'local', 'local', 'Local', NULL, NULL, NULL, NULL, NULL,
          'none', NULL, 1, 'idle', NULL, NULL,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000
        );

        CREATE TABLE team_session_snapshots (
          cache_key TEXT PRIMARY KEY,
          repository TEXT NOT NULL,
          asset_id INTEGER NOT NULL,
          digest TEXT NOT NULL,
          metadata TEXT NOT NULL,
          source TEXT NOT NULL
        );

        CREATE TABLE team_session_catalog (
          scope_key TEXT NOT NULL,
          asset_id INTEGER NOT NULL,
          cache_key TEXT NOT NULL,
          item TEXT NOT NULL,
          PRIMARY KEY (scope_key, asset_id)
        );

        CREATE INDEX team_session_catalog_cache_idx
          ON team_session_catalog (cache_key);

        CREATE TABLE team_session_drafts (
          scope_key TEXT NOT NULL,
          asset_id INTEGER NOT NULL CHECK (asset_id < 0),
          packet BLOB NOT NULL,
          item TEXT NOT NULL,
          published TEXT,
          PRIMARY KEY (scope_key, asset_id)
        );

        CREATE TABLE sessions (
          session_key TEXT PRIMARY KEY,
          raw_id TEXT NOT NULL,
          source TEXT NOT NULL,
          environment_id TEXT NOT NULL REFERENCES environments(id),
          storage_environment_id TEXT NOT NULL DEFAULT 'local',
          project_path TEXT NOT NULL,
          file_path TEXT NOT NULL,
          original_title TEXT NOT NULL,
          first_question TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          file_mtime_ms REAL NOT NULL,
          file_size INTEGER NOT NULL,
          content_indexed_mtime_ms REAL NOT NULL DEFAULT 0,
          content_indexed_size INTEGER NOT NULL DEFAULT 0,
          source_available INTEGER NOT NULL DEFAULT 1,
          pr_url TEXT,
          pr_number INTEGER,
          custom_title TEXT,
          favorited INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          hidden INTEGER NOT NULL DEFAULT 0,
          last_opened_at INTEGER,
          last_resumed_at INTEGER,
          message_count INTEGER NOT NULL DEFAULT 0,
          turn_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          indexed_at INTEGER NOT NULL,
          is_subagent INTEGER NOT NULL DEFAULT 0,
          parent_session_id TEXT,
          ai_summary TEXT,
          ai_summary_model TEXT,
          ai_summary_at INTEGER,
          ai_summary_basis REAL,
          codex_history_mode TEXT,
          codex_tool_call_state TEXT,
          team_snapshot_key TEXT REFERENCES team_session_snapshots(cache_key) ON DELETE CASCADE
        );

        CREATE VIEW local_sessions AS
          SELECT * FROM sessions WHERE team_snapshot_key IS NULL;

        CREATE INDEX sessions_visibility_idx
          ON sessions (hidden, favorited, pinned);
        CREATE INDEX sessions_source_idx
          ON sessions (source);
        CREATE INDEX sessions_project_idx
          ON sessions (project_path);
        CREATE INDEX sessions_environment_source_idx
          ON sessions (environment_id, source);
        CREATE INDEX sessions_team_snapshot_idx
          ON sessions (team_snapshot_key)
          WHERE team_snapshot_key IS NOT NULL;

        CREATE TABLE session_raw_events (
          session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
          event_index INTEGER NOT NULL,
          event_id TEXT,
          kind TEXT NOT NULL,
          role TEXT,
          occurred_at INTEGER,
          payload TEXT NOT NULL,
          index_fingerprint TEXT,
          PRIMARY KEY (session_key, event_index)
        );

        CREATE TABLE session_message_events (
          session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
          message_index INTEGER NOT NULL,
          occurred_at INTEGER NOT NULL,
          PRIMARY KEY (session_key, message_index)
        );

        CREATE INDEX session_message_events_time_idx
          ON session_message_events (occurred_at);

        CREATE TABLE session_turns (
          id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
          turn_index INTEGER NOT NULL,
          source_message_index INTEGER,
          synthetic INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'completed',
          source_turn_id TEXT,
          started_at INTEGER,
          ended_at INTEGER,
          duration_ms INTEGER,
          time_to_first_token_ms INTEGER,
          abort_reason TEXT,
          user_text TEXT NOT NULL DEFAULT '',
          assistant_text TEXT NOT NULL DEFAULT '',
          tool_text TEXT NOT NULL DEFAULT '',
          search_text TEXT NOT NULL DEFAULT '',
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          tool_names TEXT NOT NULL DEFAULT '[]',
          derivation_version INTEGER NOT NULL,
          index_fingerprint TEXT,
          UNIQUE (session_key, turn_index)
        );

        CREATE INDEX session_turns_session_idx
          ON session_turns (session_key, turn_index);
        CREATE INDEX session_turns_started_idx
          ON session_turns (started_at DESC);
        CREATE INDEX session_turns_source_turn_idx
          ON session_turns (session_key, source_turn_id)
          WHERE source_turn_id IS NOT NULL;

        CREATE TABLE turn_messages (
          turn_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
          message_index INTEGER NOT NULL,
          source_message_index INTEGER,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          occurred_at INTEGER,
          metadata TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (turn_id, message_index)
        );

        CREATE INDEX turn_messages_source_idx
          ON turn_messages (turn_id, source_message_index);

        CREATE TABLE trace_spans (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
          parent_span_id TEXT REFERENCES trace_spans(id) ON DELETE CASCADE,
          span_index INTEGER NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed',
          started_at INTEGER,
          ended_at INTEGER,
          call_id TEXT,
          input TEXT,
          output TEXT,
          error TEXT,
          attributes TEXT NOT NULL DEFAULT '{}',
          UNIQUE (turn_id, span_index)
        );

        CREATE INDEX trace_spans_parent_idx
          ON trace_spans (parent_span_id, span_index);
        CREATE INDEX trace_spans_turn_idx
          ON trace_spans (turn_id, span_index);

        CREATE TABLE token_events (
          session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
          dedupe_key TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          source_turn_id TEXT,
          PRIMARY KEY (session_key, dedupe_key)
        );

        CREATE INDEX token_events_time_idx
          ON token_events (occurred_at);
        CREATE INDEX token_events_dedupe_idx
          ON token_events (dedupe_key, total_tokens DESC, occurred_at);

        CREATE TABLE tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE session_tags (
          session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (session_key, tag_id)
        );

        CREATE TABLE session_attachments (
          session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
          attachment_id TEXT NOT NULL,
          message_index INTEGER NOT NULL,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          preview_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          size_bytes INTEGER,
          cache_path TEXT,
          PRIMARY KEY (session_key, attachment_id)
        );

        CREATE INDEX session_attachments_message_idx
          ON session_attachments (session_key, message_index);

        CREATE TABLE skill_usage_sources (
          source_path TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          kind TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          file_size INTEGER NOT NULL,
          scanned_at INTEGER NOT NULL
        );

        CREATE TABLE skill_usage_events (
          source_path TEXT NOT NULL REFERENCES skill_usage_sources(source_path) ON DELETE CASCADE,
          event_index INTEGER NOT NULL,
          agent TEXT NOT NULL,
          skill TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          session_id TEXT,
          cwd TEXT,
          skill_hash TEXT,
          PRIMARY KEY (source_path, event_index)
        );

        CREATE INDEX skill_usage_events_skill_idx
          ON skill_usage_events (agent, skill, occurred_at);
        CREATE INDEX skill_usage_events_session_idx
          ON skill_usage_events (session_id)
          WHERE session_id IS NOT NULL;

        CREATE TABLE skill_sync_bindings (
          local_skill_path TEXT PRIMARY KEY,
          portable_identity TEXT NOT NULL DEFAULT '',
          remote_skill_id TEXT NOT NULL UNIQUE,
          remote_updated_at INTEGER NOT NULL,
          remote_version INTEGER NOT NULL DEFAULT 1,
          last_content_hash TEXT NOT NULL DEFAULT '',
          last_synced_at INTEGER NOT NULL,
          direction TEXT NOT NULL
        );

        CREATE UNIQUE INDEX skill_sync_portable_identity_idx
          ON skill_sync_bindings (portable_identity)
          WHERE portable_identity <> '';

        CREATE TABLE session_sync_bindings (
          local_session_key TEXT PRIMARY KEY REFERENCES sessions(session_key) ON DELETE CASCADE,
          remote_session_id TEXT NOT NULL UNIQUE,
          last_local_revision TEXT NOT NULL,
          last_remote_revision TEXT NOT NULL,
          last_synced_at INTEGER NOT NULL,
          direction TEXT NOT NULL
        );

        CREATE TABLE api_provider_keys (
          target TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          api_key TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (target, provider_id)
        );

        CREATE TABLE session_migrations (
          id TEXT PRIMARY KEY,
          source_session_key TEXT NOT NULL,
          source_agent TEXT NOT NULL,
          target_agent TEXT NOT NULL,
          target_session_id TEXT NOT NULL,
          target_file_path TEXT NOT NULL,
          strategy TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX session_migrations_source_idx
          ON session_migrations (source_session_key, created_at DESC, id DESC);
      `,
      `
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value_text TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE app_aux_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE saved_searches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          options TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          use_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE search_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query TEXT NOT NULL,
          result_count INTEGER NOT NULL DEFAULT 0,
          searched_at INTEGER NOT NULL,
          options TEXT
        );

        CREATE INDEX search_history_time_idx
          ON search_history (searched_at DESC, id DESC);

        CREATE TABLE automation_chats (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          configured_agent_id TEXT NOT NULL,
          model_id TEXT,
          channel_id TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE automation_chat_messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL REFERENCES automation_chats(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          is_local INTEGER NOT NULL DEFAULT 0,
          sequence INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX automation_chat_messages_order_idx
          ON automation_chat_messages (chat_id, sequence);

        CREATE TABLE automation_chat_events (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL REFERENCES automation_chats(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES automation_chat_messages(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          agent_id TEXT,
          name TEXT,
          from_agent_id TEXT,
          to_agent_id TEXT,
          request_id TEXT,
          request_state TEXT,
          decision TEXT,
          metadata TEXT,
          sequence INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX automation_chat_events_order_idx
          ON automation_chat_events (message_id, sequence);

        CREATE TABLE runtime_sessions (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL REFERENCES automation_chats(id) ON DELETE CASCADE,
          runtime_id TEXT,
          state TEXT,
          provider_session_id TEXT,
          runtime_state TEXT,
          conversation TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX runtime_sessions_chat_idx
          ON runtime_sessions (chat_id);

        CREATE TABLE mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          transport TEXT NOT NULL,
          command TEXT,
          args TEXT NOT NULL,
          url TEXT,
          env TEXT NOT NULL,
          headers TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          exposure_mode TEXT NOT NULL DEFAULT 'indexed' CHECK (exposure_mode IN ('indexed', 'direct')),
          disabled_tools TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'untested',
          last_error TEXT,
          last_tested_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE mcp_tools (
          server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          input_schema TEXT NOT NULL,
          read_only INTEGER NOT NULL DEFAULT 0,
          sequence INTEGER NOT NULL,
          PRIMARY KEY (server_id, name)
        );

        CREATE TABLE runtime_invocations (
          id TEXT PRIMARY KEY,
          initiator TEXT NOT NULL CHECK (initiator = 'agentrecall'),
          surface TEXT NOT NULL,
          role TEXT,
          owner_reference TEXT NOT NULL DEFAULT '{}',
          runtime_id TEXT NOT NULL,
          channel_id TEXT,
          environment_id TEXT NOT NULL DEFAULT 'local',
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled', 'timed_out')),
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          error TEXT
        );

        CREATE INDEX runtime_invocations_started_idx
          ON runtime_invocations (started_at DESC, id DESC);

        CREATE TABLE runtime_session_bindings (
          invocation_id TEXT NOT NULL REFERENCES runtime_invocations(id) ON DELETE CASCADE,
          runtime_id TEXT NOT NULL,
          channel_id TEXT NOT NULL DEFAULT '',
          environment_id TEXT NOT NULL DEFAULT 'local',
          runtime_session_id TEXT NOT NULL,
          runtime_turn_id TEXT,
          relation TEXT NOT NULL CHECK (relation IN ('created', 'continued')),
          bound_at INTEGER NOT NULL,
          PRIMARY KEY (invocation_id, runtime_id, channel_id, environment_id, runtime_session_id)
        );

        CREATE INDEX runtime_session_bindings_session_idx
          ON runtime_session_bindings (environment_id, runtime_id, runtime_session_id, relation);
      `,
      `
        CREATE TABLE evaluation_datasets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE evaluation_dataset_items (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
          input TEXT NOT NULL,
          expected_output TEXT,
          metadata TEXT NOT NULL,
          sequence INTEGER NOT NULL
        );

        CREATE INDEX evaluation_dataset_items_order_idx
          ON evaluation_dataset_items (dataset_id, sequence);

        CREATE TABLE evaluation_evaluators (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          prompt TEXT,
          agent_id TEXT,
          runtime_id TEXT,
          threshold REAL NOT NULL,
          enabled INTEGER NOT NULL,
          dimension TEXT,
          priority TEXT,
          max_tool_failures INTEGER,
          max_turns INTEGER,
          max_tool_calls INTEGER,
          max_total_tokens INTEGER,
          max_duration_ms INTEGER,
          script_mode TEXT,
          script TEXT,
          command TEXT,
          command_args TEXT,
          subject TEXT,
          timeout_ms INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE evaluation_experiments (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          dataset_id TEXT NOT NULL REFERENCES evaluation_datasets(id),
          agent_id TEXT NOT NULL,
          repetitions INTEGER NOT NULL,
          source TEXT,
          scoring TEXT,
          stages TEXT,
          stage_by_evaluator_id TEXT,
          skill_name TEXT,
          skill_hash TEXT,
          graph TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX evaluation_experiments_skill_idx
          ON evaluation_experiments (skill_name)
          WHERE skill_name IS NOT NULL;

        CREATE TABLE evaluation_experiment_evaluators (
          experiment_id TEXT NOT NULL REFERENCES evaluation_experiments(id) ON DELETE CASCADE,
          evaluator_id TEXT NOT NULL REFERENCES evaluation_evaluators(id),
          sequence INTEGER NOT NULL,
          PRIMARY KEY (experiment_id, evaluator_id)
        );

        CREATE TABLE evaluation_runs (
          id TEXT PRIMARY KEY,
          experiment_id TEXT NOT NULL REFERENCES evaluation_experiments(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          agent_revision_id TEXT,
          skill_hash TEXT,
          engine TEXT,
          scored_case_count INTEGER,
          unscored_case_count INTEGER,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          average_score REAL,
          minimum_score REAL,
          pass_rate REAL,
          coverage REAL,
          dimensions TEXT,
          stage_scores TEXT,
          rubric_hash TEXT,
          consistency TEXT,
          scoring_version INTEGER,
          total_duration_ms INTEGER,
          error TEXT
        );

        CREATE INDEX evaluation_runs_started_idx
          ON evaluation_runs (started_at DESC);
        CREATE INDEX evaluation_runs_experiment_started_idx
          ON evaluation_runs (experiment_id, started_at DESC);

        CREATE TABLE evaluation_case_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
          dataset_item_id TEXT NOT NULL,
          repetition INTEGER NOT NULL,
          input TEXT NOT NULL,
          expected_output TEXT,
          output TEXT NOT NULL,
          error TEXT,
          duration_ms INTEGER NOT NULL,
          session_key TEXT,
          skill_name TEXT,
          skill_hash TEXT,
          skill_content_length INTEGER,
          unscored_reason TEXT,
          gate_passed INTEGER,
          score REAL,
          passed INTEGER,
          coverage REAL,
          dimensions TEXT,
          by_label TEXT,
          skipped_evaluator_ids TEXT,
          skipped_stage_ids TEXT,
          artifact_origin_kind TEXT,
          artifact_origin_reference TEXT,
          artifact_files TEXT
        );

        CREATE INDEX evaluation_case_results_run_idx
          ON evaluation_case_results (run_id);
        CREATE INDEX evaluation_case_results_session_idx
          ON evaluation_case_results (session_key)
          WHERE session_key IS NOT NULL;

        CREATE TABLE evaluation_case_nodes (
          case_result_id TEXT NOT NULL REFERENCES evaluation_case_results(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL,
          node_version INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('prepare', 'judge')),
          status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'excused', 'error', 'pending', 'disabled')),
          pending_reason TEXT,
          pending_upstream TEXT,
          started_at INTEGER,
          finished_at INTEGER,
          duration_ms INTEGER,
          attribution TEXT,
          produced_outputs TEXT,
          facts TEXT,
          sequence INTEGER NOT NULL,
          PRIMARY KEY (case_result_id, node_id)
        );

        CREATE INDEX evaluation_case_nodes_order_idx
          ON evaluation_case_nodes (case_result_id, sequence);

        CREATE TABLE evaluation_case_verdicts (
          case_result_id TEXT NOT NULL REFERENCES evaluation_case_results(id) ON DELETE CASCADE,
          verdict_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL,
          evaluator_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('met', 'unmet', 'uncertain')),
          raw REAL,
          threshold REAL,
          labels TEXT NOT NULL DEFAULT '{}',
          reason TEXT,
          evidence TEXT,
          failed_criteria TEXT,
          duration_ms INTEGER,
          sequence INTEGER NOT NULL,
          PRIMARY KEY (case_result_id, verdict_id)
        );

        CREATE INDEX evaluation_case_verdicts_node_idx
          ON evaluation_case_verdicts (case_result_id, node_id);

        CREATE TABLE evaluation_scores (
          case_result_id TEXT NOT NULL REFERENCES evaluation_case_results(id) ON DELETE CASCADE,
          evaluator_id TEXT NOT NULL,
          dimension TEXT NOT NULL,
          score REAL NOT NULL,
          passed INTEGER NOT NULL,
          reason TEXT,
          evidence TEXT,
          failed_criteria TEXT,
          duration_ms INTEGER NOT NULL,
          token_count INTEGER,
          estimated_cost REAL,
          PRIMARY KEY (case_result_id, evaluator_id, dimension)
        );

        CREATE TABLE evaluation_subjects (
          id TEXT PRIMARY KEY,
          subject_type TEXT NOT NULL CHECK (subject_type IN ('session', 'turn', 'span')),
          session_key TEXT REFERENCES sessions(session_key) ON DELETE CASCADE,
          turn_id TEXT REFERENCES session_turns(id) ON DELETE CASCADE,
          span_id TEXT REFERENCES trace_spans(id) ON DELETE CASCADE,
          CHECK (
            (subject_type = 'session' AND session_key IS NOT NULL AND turn_id IS NULL AND span_id IS NULL) OR
            (subject_type = 'turn' AND session_key IS NULL AND turn_id IS NOT NULL AND span_id IS NULL) OR
            (subject_type = 'span' AND session_key IS NULL AND turn_id IS NULL AND span_id IS NOT NULL)
          )
        );

        CREATE UNIQUE INDEX evaluation_subject_session_idx
          ON evaluation_subjects (session_key)
          WHERE subject_type = 'session';
        CREATE UNIQUE INDEX evaluation_subject_turn_idx
          ON evaluation_subjects (turn_id)
          WHERE subject_type = 'turn';
        CREATE UNIQUE INDEX evaluation_subject_span_idx
          ON evaluation_subjects (span_id)
          WHERE subject_type = 'span';

        CREATE TABLE evaluation_results (
          id TEXT PRIMARY KEY,
          subject_id TEXT NOT NULL REFERENCES evaluation_subjects(id) ON DELETE CASCADE,
          evaluator_id TEXT,
          metric TEXT NOT NULL,
          score REAL,
          label TEXT,
          passed INTEGER,
          explanation TEXT,
          evidence TEXT,
          evaluator_version TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX evaluation_results_subject_idx
          ON evaluation_results (subject_id, created_at DESC);

        CREATE TABLE memory_cards (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('experience', 'decision')),
          problem TEXT NOT NULL,
          solution TEXT NOT NULL,
          previous_solution TEXT,
          failed_attempts TEXT NOT NULL DEFAULT '[]',
          keywords TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
          superseded_by TEXT REFERENCES memory_cards(id) ON DELETE SET NULL,
          search_text TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX memory_cards_project_idx
          ON memory_cards (project_path, status, updated_at DESC);

        CREATE TABLE memory_card_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id TEXT NOT NULL REFERENCES memory_cards(id) ON DELETE CASCADE,
          session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
          first_turn_index INTEGER NOT NULL,
          last_turn_index INTEGER NOT NULL CHECK (last_turn_index >= first_turn_index),
          created_at INTEGER NOT NULL
        );

        CREATE INDEX memory_card_sources_card_idx
          ON memory_card_sources (card_id);
        CREATE INDEX memory_card_sources_session_idx
          ON memory_card_sources (session_key);

        CREATE TRIGGER memory_card_sources_delete_orphan
          AFTER DELETE ON memory_card_sources
          BEGIN
            DELETE FROM memory_cards
            WHERE id = OLD.card_id
              AND NOT EXISTS (
                SELECT 1 FROM memory_card_sources WHERE card_id = OLD.card_id
              );
          END;

        CREATE TABLE memory_extraction_state (
          session_key TEXT PRIMARY KEY REFERENCES sessions(session_key) ON DELETE CASCADE,
          last_extracted_turn_index INTEGER,
          observed_signature TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'succeeded_no_output', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_retry_at INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          last_error TEXT,
          last_run_at INTEGER,
          updated_at INTEGER NOT NULL
        );
      `,
      `
        CREATE VIRTUAL TABLE sessions_fts USING fts5(
          custom_title,
          original_title,
          first_question,
          project_path,
          raw_id,
          ai_summary,
          content='sessions',
          content_rowid='rowid',
          tokenize='trigram'
        );

        CREATE TRIGGER sessions_fts_ai AFTER INSERT ON sessions BEGIN
          INSERT INTO sessions_fts(rowid, custom_title, original_title, first_question, project_path, raw_id, ai_summary)
          VALUES (new.rowid, new.custom_title, new.original_title, new.first_question, new.project_path, new.raw_id, new.ai_summary);
        END;

        CREATE TRIGGER sessions_fts_ad AFTER DELETE ON sessions BEGIN
          INSERT INTO sessions_fts(sessions_fts, rowid, custom_title, original_title, first_question, project_path, raw_id, ai_summary)
          VALUES ('delete', old.rowid, old.custom_title, old.original_title, old.first_question, old.project_path, old.raw_id, old.ai_summary);
        END;

        CREATE TRIGGER sessions_fts_au AFTER UPDATE OF custom_title, original_title, first_question, project_path, raw_id, ai_summary ON sessions BEGIN
          INSERT INTO sessions_fts(sessions_fts, rowid, custom_title, original_title, first_question, project_path, raw_id, ai_summary)
          VALUES ('delete', old.rowid, old.custom_title, old.original_title, old.first_question, old.project_path, old.raw_id, old.ai_summary);
          INSERT INTO sessions_fts(rowid, custom_title, original_title, first_question, project_path, raw_id, ai_summary)
          VALUES (new.rowid, new.custom_title, new.original_title, new.first_question, new.project_path, new.raw_id, new.ai_summary);
        END;

        CREATE VIRTUAL TABLE session_turns_fts USING fts5(
          search_text,
          content='session_turns',
          content_rowid='rowid',
          tokenize='trigram'
        );

        CREATE TRIGGER session_turns_fts_ai AFTER INSERT ON session_turns BEGIN
          INSERT INTO session_turns_fts(rowid, search_text)
          VALUES (new.rowid, new.search_text);
        END;

        CREATE TRIGGER session_turns_fts_ad AFTER DELETE ON session_turns BEGIN
          INSERT INTO session_turns_fts(session_turns_fts, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
        END;

        CREATE TRIGGER session_turns_fts_au AFTER UPDATE OF search_text ON session_turns BEGIN
          INSERT INTO session_turns_fts(session_turns_fts, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO session_turns_fts(rowid, search_text)
          VALUES (new.rowid, new.search_text);
        END;

        CREATE VIRTUAL TABLE memory_cards_fts USING fts5(
          search_text,
          content='memory_cards',
          content_rowid='rowid',
          tokenize='trigram'
        );

        CREATE TRIGGER memory_cards_fts_ai AFTER INSERT ON memory_cards BEGIN
          INSERT INTO memory_cards_fts(rowid, search_text)
          VALUES (new.rowid, new.search_text);
        END;

        CREATE TRIGGER memory_cards_fts_ad AFTER DELETE ON memory_cards BEGIN
          INSERT INTO memory_cards_fts(memory_cards_fts, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
        END;

        CREATE TRIGGER memory_cards_fts_au AFTER UPDATE OF search_text ON memory_cards BEGIN
          INSERT INTO memory_cards_fts(memory_cards_fts, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO memory_cards_fts(rowid, search_text)
          VALUES (new.rowid, new.search_text);
        END;
      `,
    ],
  },
  {
    version: 2,
    name: "Persist Codex fork origins",
    statements: [
      "ALTER TABLE sessions ADD COLUMN forked_from_id TEXT",
      "ALTER TABLE sessions ADD COLUMN forked_from_ordinal_exclusive INTEGER",
      // Re-read existing headers once, including those of unchanged rollouts.
      `UPDATE sessions SET content_indexed_mtime_ms = 0
        WHERE storage_environment_id = 'local' AND team_snapshot_key IS NULL
          AND source IN ('codex-cli', 'codex-app', 'stepcode-codex', 'tcodex-cli')`,
    ],
  },
];
