export type PathwayStateRow = {
  slide_id: string
}

export type PathwayStateItem<Row extends PathwayStateRow = PathwayStateRow> = {
  id: string
  slideIds: string[]
  present: Row[]
  missing: string[]
}

export type PathwayStateSnapshot<
  Row extends PathwayStateRow = PathwayStateRow,
  Item extends PathwayStateItem<Row> = PathwayStateItem<Row>
> = {
  slides: Row[]
  pathways: Item[]
}

export type PendingPathwaySlides = Record<string, string[]>

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export function optimisticallySetPathwaySlides<
  Row extends PathwayStateRow,
  Item extends PathwayStateItem<Row>,
  Snapshot extends PathwayStateSnapshot<Row, Item>
>(snapshot: Snapshot, pathwayId: string, slideIds: string[]): Snapshot {
  const byId = new Map(snapshot.slides.map((slide) => [slide.slide_id, slide]))
  return {
    ...snapshot,
    pathways: snapshot.pathways.map((pathway) => {
      if (pathway.id !== pathwayId) return pathway
      const present: Row[] = []
      const missing: string[] = []
      for (const id of slideIds) {
        const slide = byId.get(id)
        if (slide) present.push(slide)
        else missing.push(id)
      }
      return { ...pathway, slideIds: [...slideIds], present, missing }
    }) as Item[]
  }
}

export function reconcilePathwaySnapshot<
  Row extends PathwayStateRow,
  Item extends PathwayStateItem<Row>,
  Snapshot extends PathwayStateSnapshot<Row, Item>
>(
  _current: Snapshot,
  incoming: Snapshot,
  pending: PendingPathwaySlides
): { snapshot: Snapshot; pending: PendingPathwaySlides } {
  let snapshot = incoming
  const remaining: PendingPathwaySlides = {}
  for (const [pathwayId, slideIds] of Object.entries(pending)) {
    const incomingPathway = incoming.pathways.find((pathway) => pathway.id === pathwayId)
    if (!incomingPathway) continue
    if (sameIds(incomingPathway.slideIds, slideIds)) continue
    remaining[pathwayId] = [...slideIds]
    snapshot = optimisticallySetPathwaySlides(snapshot, pathwayId, slideIds)
  }
  return { snapshot: Object.keys(pending).length ? snapshot : incoming, pending: remaining }
}
