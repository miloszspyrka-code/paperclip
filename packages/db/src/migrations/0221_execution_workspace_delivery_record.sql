ALTER TABLE "execution_workspaces" ADD COLUMN "result_commit_sha" text;
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "result_branch" text;
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "pushed_remote" text;
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "remote_ref" text;
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "remote_verified_sha" text;
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "merged_to_base" boolean;
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "delivery_state" text;
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "tests_run" integer;
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "tests_passed" integer;
