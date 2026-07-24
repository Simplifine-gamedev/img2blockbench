import { notFound } from "next/navigation";
import { DemoShell } from "@/components/demo-shell";
import { animalOrder, isAnimalSlug } from "@/lib/animals";

export function generateStaticParams() {
  return animalOrder.map((animal) => ({ animal }));
}

export default async function AnimalPage({
  params,
}: {
  params: Promise<{ animal: string }>;
}) {
  const { animal } = await params;

  if (!isAnimalSlug(animal)) {
    notFound();
  }

  return <DemoShell initialAnimal={animal} />;
}
