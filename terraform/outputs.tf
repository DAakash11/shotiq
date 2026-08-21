# Values this configuration publishes after apply.
#
# Outputs are how one part of a system hands facts to another without
# anybody copying them by hand: `terraform output -raw project_number`
# feeds a shell script or a CI step directly, so a number that GCP chose
# never gets retyped into a workflow file where it can drift.

output "project_id" {
  description = "The project everything is provisioned into."
  value       = data.google_project.this.project_id
}

output "project_number" {
  description = "GCP's own numeric ID for the project. Needed by Workload Identity Federation, which addresses projects by number rather than by ID."
  value       = data.google_project.this.number
}

output "region" {
  description = "Region regional resources are created in."
  value       = var.region
}
