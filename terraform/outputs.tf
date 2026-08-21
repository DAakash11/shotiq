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

output "network_name" {
  description = "VPC the cluster attaches to."
  value       = google_compute_network.vpc.name
}

output "subnet_name" {
  description = "Subnet the nodes take their addresses from."
  value       = google_compute_subnetwork.gke.name
}

output "cluster_name" {
  description = "GKE cluster name."
  value       = google_container_cluster.primary.name
}

output "cluster_location" {
  description = "Zone the cluster lives in. Needed by every gcloud and kubectl call against it."
  value       = google_container_cluster.primary.location
}

output "kubectl_config_command" {
  description = "Run this to point kubectl at the cluster. Emitted rather than documented so the names can never drift from what was actually built."
  value       = "gcloud container clusters get-credentials ${google_container_cluster.primary.name} --zone ${google_container_cluster.primary.location} --project ${var.project_id}"
}

output "node_service_account" {
  description = "Least-privilege identity the nodes run as, in place of the Compute Engine default SA and its project Editor role."
  value       = google_service_account.gke_nodes.email
}

output "registry_url" {
  description = "Docker registry host and path to tag images against. Feeds the CI workflow, so the value GCP chose is never retyped into a YAML file where it can drift."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.shotiq.repository_id}"
}
