interface EvaluationSchemaDatabase { exec(sql: string): void }

export function ensureEvaluationSchema(db: EvaluationSchemaDatabase): void {
  db.exec(`
    create table if not exists evaluation_datasets (id text primary key, name text not null, description text not null, created_at integer not null, updated_at integer not null);
    create table if not exists evaluation_dataset_items (id text primary key, dataset_id text not null references evaluation_datasets(id) on delete cascade, input text not null, expected_output text, metadata_json text not null, sequence integer not null);
    create index if not exists evaluation_dataset_items_order on evaluation_dataset_items(dataset_id, sequence);
    create table if not exists evaluation_evaluators (id text primary key, name text not null, kind text not null, prompt text, agent_id text, runtime_id text, threshold real not null, enabled integer not null, created_at integer not null, updated_at integer not null);
    create table if not exists evaluation_experiments (id text primary key, name text not null, dataset_id text not null references evaluation_datasets(id), agent_id text not null, repetitions integer not null, created_at integer not null, updated_at integer not null);
    create table if not exists evaluation_experiment_evaluators (experiment_id text not null references evaluation_experiments(id) on delete cascade, evaluator_id text not null references evaluation_evaluators(id), sequence integer not null, primary key(experiment_id, evaluator_id));
    create table if not exists evaluation_runs (id text primary key, experiment_id text not null references evaluation_experiments(id) on delete cascade, status text not null, agent_revision_id text, started_at integer not null, finished_at integer, average_score real, minimum_score real, pass_rate real, total_duration_ms integer, error text);
    create table if not exists evaluation_case_results (id text primary key, run_id text not null references evaluation_runs(id) on delete cascade, dataset_item_id text not null, repetition integer not null, input text not null, expected_output text, output text not null, error text, duration_ms integer not null);
    create table if not exists evaluation_scores (case_result_id text not null references evaluation_case_results(id) on delete cascade, evaluator_id text not null, score real not null, passed integer not null, reason text, evidence_json text, failed_criteria_json text, duration_ms integer not null, token_count integer, estimated_cost real, primary key(case_result_id, evaluator_id));
  `);
}
