# The identity the cluster's nodes run as.
#
# This file exists to avoid a default. Left alone, GKE runs nodes as the
# Compute Engine default service account -- which GCP grants the
# project-wide EDITOR role. Editor can create, modify and delete nearly
# everything in the project, including the cluster itself and the billing
# -relevant resources around it.
#
# So the default posture is: anything that gets code execution on a node
# holds a credential that can rewrite the whole project. That credential is
# also reachable from inside a pod over the metadata endpoint. It is the
# single most consequential GKE default, and turning it off is one
# resource and five role bindings.

resource "google_service_account" "gke_nodes" {
  # account_id becomes the local part of the email and cannot be changed
  # afterwards. Keep it descriptive: it will appear in audit logs.
  account_id   = "${local.name_prefix}-gke-nodes"
  display_name = "ShotIQ GKE node pool"
  description  = "Least-privilege identity for GKE nodes. Replaces the Compute Engine default SA, which carries project Editor."
}

locals {
  # Exactly what a node needs to do its job, and nothing beyond it:
  #
  #   artifactregistry.reader        pull images -- READER, not writer.
  #                                  Nodes consume images; CI produces
  #                                  them. A node that can push is a node
  #                                  that can replace the image everything
  #                                  else is about to pull.
  #   logging.logWriter              ship container logs to Cloud Logging
  #   monitoring.metricWriter        ship metrics -- write only
  #   monitoring.viewer              read back its own metrics, which the
  #                                  autoscaler needs
  #   stackdriver.resourceMetadata.writer
  #                                  report node/pod metadata so metrics
  #                                  arrive labelled with what produced
  #                                  them rather than as anonymous numbers
  gke_node_roles = [
    "roles/artifactregistry.reader",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
  ]
}

# for_each rather than count. Both loop, but they key the resources
# differently in state, and that difference bites: count keys by POSITION,
# so removing the second role in a list of five renumbers the three after
# it and Terraform destroys and recreates every one. for_each keys by
# VALUE, so removing a role touches exactly that binding.
#
# The rule worth carrying: count for "N identical things", for_each for
# "one thing per named item".
resource "google_project_iam_member" "gke_nodes" {
  for_each = toset(local.gke_node_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}
