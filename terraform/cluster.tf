# The GKE cluster, and the node pool that does the work.
#
# Two resources rather than one, deliberately. A cluster can be declared
# with nodes inline, but then changing the machine type means replacing the
# CLUSTER -- control plane, addons and all -- instead of replacing a pool.
# Split, the pool is disposable and the cluster is not.

resource "google_container_cluster" "primary" {
  name = "${local.name_prefix}-gke"

  # The provider's default create timeout is 40 minutes, which is tuned for
  # a cluster that is slow rather than one that is never going to arrive.
  #
  # A zone with no spare e2 capacity does not refuse the request -- it
  # queues it and keeps retrying until something times out. us-central1-a
  # happened to fail fast; us-central1-c sat in PROVISIONING for 35 minutes
  # before returning GCE_STOCKOUT. Waiting 40 minutes to be told "try a
  # different zone" is 40 minutes not spent trying a different zone.
  #
  # 20 minutes is comfortably longer than a healthy zonal cluster needs
  # (typically 8) and short enough that a stockout is a coffee break
  # rather than an afternoon.
  timeouts {
    create = "20m"
    update = "20m"
    delete = "20m"
  }

  # A zone, not a region. This one argument is the zonal/regional switch:
  # give it "us-central1" and GKE builds a three-zone control plane and
  # triples the nodes to match.
  location = var.zone

  # --- the default node pool dance -------------------------------------
  #
  # GKE will not create a cluster with no nodes, but the pool it makes for
  # you cannot be fully configured through this resource. The idiom is to
  # let it build one, then immediately throw it away and attach a pool
  # that IS fully declared. It looks odd and it is the documented pattern.
  remove_default_node_pool = true
  initial_node_count       = 1

  # --- networking ------------------------------------------------------
  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.gke.id

  # VPC_NATIVE is what makes pods hold real VPC addresses. The alternative,
  # ROUTES, is the older model and is being retired.
  networking_mode = "VPC_NATIVE"

  # Bind the cluster to the secondary ranges declared in network.tf. These
  # are referenced BY NAME, and the names have to match exactly -- a typo
  # here surfaces as a cluster that will not create, several minutes in.
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # --- cost and teardown safety ----------------------------------------
  #
  # THE most important line in this repository for a project on trial
  # credit. The provider defaults this to TRUE, and with it true
  # `terraform destroy` refuses to delete the cluster -- it errors out,
  # the destroy stops there, and a cluster you believed was gone keeps
  # billing overnight while the state file says otherwise.
  #
  # It exists to stop someone deleting production by accident, which is a
  # real and good reason. This cluster is created and destroyed every
  # session by design, so the protection is inverted here: it would cause
  # exactly the runaway cost it normally prevents.
  deletion_protection = false

  # --- version management ----------------------------------------------
  #
  # A release channel means Google chooses and applies control-plane
  # versions. REGULAR is the middle option: RAPID gets new Kubernetes
  # minors first and breaks first, STABLE lags by months. Pinning an exact
  # version instead means owning upgrades by hand, and an unattended
  # cluster on an unsupported version is how clusters die.
  release_channel {
    channel = "REGULAR"
  }

  # --- Workload Identity -----------------------------------------------
  #
  # Lets a Kubernetes ServiceAccount impersonate a GCP service account, so
  # a pod needing a Google API is handed a short-lived token instead of a
  # mounted key file. Free to enable and awkward to add later. Not used by
  # ShotIQ's pods yet -- it is the same idea as the CI federation in step
  # 6, applied inside the cluster.
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # --- logging and monitoring ------------------------------------------
  #
  # Set explicitly rather than left default, so the volume of billable
  # telemetry is a decision on the record.
  #
  # SYSTEM_COMPONENTS is the control plane and kubelet; WORKLOADS is
  # everything your containers write to stdout. Both are kept: Cloud
  # Logging's free allowance is 50 GiB per project per month and five
  # small pods will not come close, and workload logs are what makes a
  # crash-looping pod diagnosable.
  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]

    # Managed Service for Prometheus is billed per sample ingested, and it
    # is on by default on new clusters. Off until step 7 decides whether
    # it is wanted -- an always-on metrics pipeline is precisely the kind
    # of small recurring charge that goes unnoticed. GKE system metrics
    # reach Cloud Monitoring free without it.
    managed_prometheus {
      enabled = false
    }
  }
}

resource "google_container_node_pool" "primary" {
  name     = "${local.name_prefix}-pool"
  cluster  = google_container_cluster.primary.name
  location = var.zone

  # --- autoscaling ------------------------------------------------------
  #
  # The ceiling is the cost cap: the pool cannot bill more than
  # node_max_count nodes no matter what gets scheduled. A pod that cannot
  # fit stays Pending, which is a visible, free failure -- far better than
  # a cluster that silently grows to satisfy a bad resource request.
  autoscaling {
    min_node_count = var.node_min_count
    max_node_count = var.node_max_count
  }

  # Starting size, and ONLY the starting size. The autoscaler owns the count
  # from the moment the pool exists, which is why this is `initial_`.
  initial_node_count = var.node_min_count

  lifecycle {
    # initial_node_count FORCES REPLACEMENT of the node pool when it
    # changes, which is a genuinely bad trade: raising the autoscaler's
    # floor from 2 to 3 would otherwise destroy both working nodes and
    # rebuild them -- another roll of the GCE_STOCKOUT dice for a change
    # that needs no disruption at all.
    #
    # Ignoring it is correct rather than a workaround. The value is a seed
    # consumed once at creation; afterwards the real count belongs to the
    # autoscaler, and min_node_count = 3 is enough to make it add a third
    # node in place. Terraform diffing a field it does not own is the bug.
    #
    # Caught by reading the plan for "forces replacement" instead of
    # skimming the summary line. `Plan: 1 to add, 1 to destroy` and
    # `Plan: 0 to add, 1 to change` look similar and are not.
    ignore_changes = [initial_node_count]
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type = var.node_machine_type
    disk_size_gb = var.node_disk_size_gb

    # pd-balanced, not the cheaper pd-standard. A spinning-disk-backed
    # boot volume makes image pulls and kubelet startup noticeably slow,
    # and on Spot nodes that replace themselves often, node startup time
    # is something you feel.
    disk_type = "pd-balanced"

    # Spot: surplus capacity, 60-80% off, reclaimable on 30 seconds'
    # notice. The taint GKE applies is automatic; a Deployment simply
    # reschedules its replica elsewhere.
    spot = var.use_spot_nodes

    # The least-privilege identity from iam.tf, instead of the Compute
    # Engine default service account and its project-wide Editor role.
    service_account = google_service_account.gke_nodes.email

    # Scopes are the OLD, coarse authorisation layer and they sit in front
    # of IAM: a call must pass BOTH. cloud-platform means "do not filter
    # here", leaving the service account's IAM roles as the only limit --
    # which is what makes the five roles in iam.tf the real boundary
    # rather than a second, confusing one.
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]

    # Blocks the legacy metadata endpoints, which served instance
    # credentials without the header guard that the v1 endpoint requires.
    # Any pod able to make an outbound HTTP request could read the node's
    # token through them. Off by default on new clusters; set explicitly
    # because it is worth knowing it is off.
    metadata = {
      disable-legacy-endpoints = "true"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    labels = {
      environment = "demo"
      managed-by  = "terraform"
    }
  }
}
